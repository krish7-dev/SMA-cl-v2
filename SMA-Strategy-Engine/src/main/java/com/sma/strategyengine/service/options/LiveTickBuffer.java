package com.sma.strategyengine.service.options;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.MeterRegistry;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Per-session buffer that writes raw ticks to a Redis Stream (sma:ticks:{sessionId}).
 *
 * <p><b>Hot path (sub-ms):</b> {@link #add} → XADD to Redis. No DB, no HTTP.
 *
 * <p><b>Redis outage path:</b> XADD failure → tick is placed in a bounded emergency
 * {@link LinkedBlockingDeque} (cap {#EMERGENCY_CAP}).  A background health-check
 * thread (every {#HEALTH_CHECK_MS} ms) pings Redis and, on recovery, flushes the
 * emergency buffer to the stream before resuming normal XADD.
 *
 * <p><b>Emergency buffer retention:</b>
 * At observed peak burst rate of ~100 ticks/s the cap of {#EMERGENCY_CAP} entries
 * provides ≈ 50 seconds of retention — acceptable for transient Redis outages.
 * At typical rate of ~63 ticks/s the retention is ≈ 79 seconds.
 * If the buffer fills, ticks are dropped with an explicit metric increment + warning log.
 *
 * <p>The consumer group for this stream is created by
 * {@code LiveOptionsSession.run()} (XGROUP CREATE ... $ MKSTREAM) before any
 * XADD occurs, so the Data Engine drainer always has a group to read from.
 */
@Slf4j
public class LiveTickBuffer {

    // ── Constants ─────────────────────────────────────────────────────────────

    /** Hard cap on emergency buffer entries. */
    static final int  EMERGENCY_CAP    = 5_000;
    /** Redis health-check interval when redis is believed down. */
    static final long HEALTH_CHECK_MS  = 5_000L;

    static final String STREAM_PREFIX = "sma:ticks:";
    static final ZoneId IST           = ZoneId.of("Asia/Kolkata");

    // ── State ─────────────────────────────────────────────────────────────────

    private final String            sessionId;
    private final String            provider;
    private final String            streamKey;
    private final StringRedisTemplate redisTemplate;
    private final ObjectMapper      objectMapper;
    private final MeterRegistry     meterRegistry;

    /**
     * Bounded emergency buffer: absorbs ticks when Redis is unreachable.
     * LinkedBlockingDeque is bounded + thread-safe; tail-add never blocks (offer semantics).
     */
    private final LinkedBlockingDeque<BufferedTick> emergencyBuffer =
            new LinkedBlockingDeque<>(EMERGENCY_CAP);

    private volatile boolean redisHealthy = true;
    private volatile boolean stopped      = false;

    /** Rate-limit log noise — one warning per 10-second window. */
    private final AtomicLong lastWarnMs   = new AtomicLong(0L);

    private final ScheduledExecutorService healthMonitor;

    // ── Inner record ──────────────────────────────────────────────────────────

    public record BufferedTick(
            long   instrumentToken,
            String symbol,
            String exchange,
            double ltp,
            long   volume,
            long   epochMs
    ) {}

    // ── Constructor ───────────────────────────────────────────────────────────

    public LiveTickBuffer(String sessionId, String provider,
                          StringRedisTemplate redisTemplate,
                          ObjectMapper objectMapper,
                          MeterRegistry meterRegistry) {
        this.sessionId     = sessionId;
        this.provider      = provider;
        this.streamKey     = STREAM_PREFIX + sessionId;
        this.redisTemplate = redisTemplate;
        this.objectMapper  = objectMapper;
        this.meterRegistry = meterRegistry;

        // Log computed retention window at startup (informational)
        log.info("LiveTickBuffer started: sessionId={} streamKey={} emergencyCap={} " +
                 "retentionAtPeakBurst(100tps)={}s retentionAtTypical(63tps)={}s",
                 sessionId, streamKey, EMERGENCY_CAP,
                 EMERGENCY_CAP / 100, EMERGENCY_CAP / 63);

        this.healthMonitor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "tick-buf-health-" + sessionId.substring(0, 8));
            t.setDaemon(true);
            return t;
        });
        healthMonitor.scheduleAtFixedRate(
                this::checkHealthAndFlushEmergency,
                HEALTH_CHECK_MS, HEALTH_CHECK_MS, TimeUnit.MILLISECONDS);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Records a raw tick. On the hot path this is a single Redis XADD (sub-ms).
     * If Redis is unhealthy, the tick is placed in the bounded emergency buffer.
     */
    public void add(long instrumentToken, String symbol, String exchange,
                    double ltp, long volume, long epochMs) {
        if (stopped) return;
        BufferedTick tick = new BufferedTick(instrumentToken, symbol, exchange, ltp, volume, epochMs);
        if (redisHealthy) {
            xadd(tick);
        } else {
            bufferEmergency(tick);
        }
    }

    /**
     * Stops the health-check thread. The Redis stream retains all data via TTL;
     * no in-JVM flush is needed.
     */
    public void stop() {
        stopped = true;
        healthMonitor.shutdownNow();
        // Emergency buffer entries are not flushed — they represent ticks from a Redis-down
        // window. Dropping them here is intentional; the OOM risk of holding them is greater
        // than the data loss risk (stream TTL covers recovery window).
        int remaining = emergencyBuffer.size();
        if (remaining > 0) {
            log.warn("LiveTickBuffer stopped with {} entries in emergency buffer (session={}). " +
                     "These ticks are dropped.", remaining, sessionId);
            meterRegistry.counter("redis.tick.events.dropped", "sessionId", sessionId)
                         .increment(remaining);
        }
        emergencyBuffer.clear();
    }

    // ── XADD ─────────────────────────────────────────────────────────────────

    private void xadd(BufferedTick tick) {
        try {
            String json = serialize(tick);
            redisTemplate.opsForStream().add(streamKey, Map.of("data", json));
        } catch (Exception e) {
            redisHealthy = false;
            meterRegistry.counter("redis.tick.write.failures", "sessionId", sessionId).increment();

            // Rate-limited warning (once per 10 s)
            long now = System.currentTimeMillis();
            if (now - lastWarnMs.get() > 10_000L && lastWarnMs.compareAndSet(lastWarnMs.get(), now)) {
                log.error("LiveTickBuffer: Redis XADD failed (session={}), switching to emergency buffer: {}",
                        sessionId, e.getMessage());
            }
            bufferEmergency(tick);
        }
    }

    private void bufferEmergency(BufferedTick tick) {
        if (!emergencyBuffer.offerLast(tick)) {
            // Buffer full — tick is permanently dropped
            meterRegistry.counter("redis.tick.events.dropped", "sessionId", sessionId).increment();
            long now = System.currentTimeMillis();
            if (now - lastWarnMs.get() > 10_000L && lastWarnMs.compareAndSet(lastWarnMs.get(), now)) {
                log.error("LiveTickBuffer: emergency buffer FULL ({} cap) — tick DROPPED (session={}). " +
                          "Redis has been down > {}s.",
                        EMERGENCY_CAP, sessionId, EMERGENCY_CAP / 100);
            }
        }
    }

    // ── Health check + emergency flush ────────────────────────────────────────

    /**
     * Called every {@value #HEALTH_CHECK_MS} ms while the health monitor is running.
     * Tries a Redis PING; on success, flushes emergency buffer in XADD order.
     */
    private void checkHealthAndFlushEmergency() {
        if (stopped || redisHealthy) return;
        try {
            redisTemplate.getConnectionFactory().getConnection().ping();
            log.info("LiveTickBuffer: Redis recovered (session={}), flushing {} emergency entries",
                    sessionId, emergencyBuffer.size());
            redisHealthy = true;
            flushEmergencyBuffer();
        } catch (Exception e) {
            // Redis still down — silent, outer loop will retry
        }
    }

    private void flushEmergencyBuffer() {
        int flushed = 0;
        BufferedTick tick;
        while ((tick = emergencyBuffer.pollFirst()) != null) {
            try {
                String json = serialize(tick);
                redisTemplate.opsForStream().add(streamKey, Map.of("data", json));
                flushed++;
            } catch (Exception e) {
                redisHealthy = false;
                emergencyBuffer.addFirst(tick); // put it back at the front
                log.warn("LiveTickBuffer: flush aborted at entry {} — Redis went down again (session={})",
                        flushed, sessionId);
                return;
            }
        }
        if (flushed > 0) {
            log.info("LiveTickBuffer: flushed {} emergency entries to Redis (session={})", flushed, sessionId);
        }
    }

    // ── Serialization ─────────────────────────────────────────────────────────

    private String serialize(BufferedTick tick) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("instrumentToken", tick.instrumentToken());
        map.put("symbol",          tick.symbol());
        map.put("exchange",        tick.exchange());
        map.put("ltp",             tick.ltp());
        map.put("volume",          tick.volume());
        map.put("tickTime",        epochToIstString(tick.epochMs()));
        map.put("sessionId",       sessionId);
        map.put("provider",        provider);
        try {
            return objectMapper.writeValueAsString(map);
        } catch (Exception e) {
            // Fallback: manual JSON (should never happen with simple types)
            return String.format(
                "{\"instrumentToken\":%d,\"ltp\":%.4f,\"tickTime\":\"%s\",\"sessionId\":\"%s\",\"provider\":\"%s\"}",
                tick.instrumentToken(), tick.ltp(), epochToIstString(tick.epochMs()), sessionId, provider);
        }
    }

    /** Converts epoch milliseconds to an IST LocalDateTime string (matches Data Engine tick_time format). */
    public static String epochToIstString(long epochMs) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(epochMs), IST).toString();
    }
}
