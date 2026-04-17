package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient;
import lombok.extern.slf4j.Slf4j;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

/**
 * Per-session buffer that accumulates raw ticks and flushes them to
 * the Data Engine tick ingest endpoint in batches.
 *
 * Design mirrors {@link LiveCandleBuffer} — zero impact on the hot tick path.
 * Flushes when batch reaches {@value #BATCH_SIZE} or every {@value #FLUSH_INTERVAL_MS} ms.
 */
@Slf4j
public class LiveTickBuffer {

    private static final int  BATCH_SIZE        = 50;
    private static final long FLUSH_INTERVAL_MS = 10_000L;
    private static final long MAX_BACKOFF_MS    = 30_000L;

    private final String           sessionId;
    private final String           provider;
    private final DataEngineClient dataEngineClient;

    public record BufferedTick(
            long   instrumentToken,
            String symbol,
            String exchange,
            double ltp,
            long   volume,
            long   epochMs
    ) {}

    private final BlockingQueue<BufferedTick> queue = new LinkedBlockingQueue<>();
    private final ScheduledExecutorService   scheduler;
    // Dedicated single-thread executor for HTTP send + retry — keeps the scheduler thread free.
    private final ExecutorService            sendExecutor;
    private       ScheduledFuture<?>         flushTask;
    private volatile boolean                 stopped = false;

    public LiveTickBuffer(String sessionId, String provider, DataEngineClient dataEngineClient) {
        this.sessionId        = sessionId;
        this.provider         = provider;
        this.dataEngineClient = dataEngineClient;
        this.scheduler        = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "live-tick-buf-sched-" + sessionId.substring(0, 8));
            t.setDaemon(true);
            return t;
        });
        this.sendExecutor     = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "live-tick-buf-send-" + sessionId.substring(0, 8));
            t.setDaemon(true);
            return t;
        });
        this.flushTask = scheduler.scheduleAtFixedRate(
                this::flushBatch, FLUSH_INTERVAL_MS, FLUSH_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    public void add(long instrumentToken, String symbol, String exchange,
                    double ltp, long volume, long epochMs) {
        if (stopped) return;
        queue.offer(new BufferedTick(instrumentToken, symbol, exchange, ltp, volume, epochMs));
        if (queue.size() >= BATCH_SIZE) {
            scheduler.execute(this::flushBatch);
        }
    }

    public void stop() {
        stopped = true;
        if (flushTask != null) flushTask.cancel(false);
        flushBatch();          // drain remaining into sendExecutor
        scheduler.shutdownNow();
        sendExecutor.shutdown();
        try { sendExecutor.awaitTermination(30, TimeUnit.SECONDS); }
        catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }

    // Runs on the single scheduler thread — drains queue and hands off to sendExecutor immediately.
    private void flushBatch() {
        if (queue.isEmpty()) return;
        List<BufferedTick> batch = new ArrayList<>(BATCH_SIZE);
        queue.drainTo(batch, BATCH_SIZE);
        if (batch.isEmpty()) return;
        sendExecutor.submit(() -> sendWithRetry(batch));
    }

    private void sendWithRetry(List<BufferedTick> batch) {
        long backoff = 1_000L;
        int  attempt = 0;
        while (!stopped) {
            try {
                dataEngineClient.ingestLiveTicks(sessionId, provider, batch);
                if (attempt > 0) {
                    log.info("LiveTickBuffer: tick ingest recovered after {} retries (sessionId={})", attempt, sessionId);
                }
                log.debug("LiveTickBuffer: flushed {} ticks (sessionId={})", batch.size(), sessionId);
                return;
            } catch (Exception e) {
                attempt++;
                log.warn("LiveTickBuffer: ingest attempt {} failed (sessionId={}), retrying in {}ms: {}",
                        attempt, sessionId, backoff, e.getMessage());
                try { Thread.sleep(backoff); } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    log.warn("LiveTickBuffer: retry interrupted, dropping {} ticks (sessionId={})",
                            batch.size(), sessionId);
                    return;
                }
                backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            }
        }
        log.warn("LiveTickBuffer: session stopped during retry, dropping {} ticks (sessionId={})",
                batch.size(), sessionId);
    }

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    /** Converts epoch milliseconds to IST LocalDateTime string for the ingest payload (consistent with candle open_time). */
    public static String epochToIstString(long epochMs) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(epochMs), IST).toString();
    }
}
