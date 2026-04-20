package com.sma.dataengine.service;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.stream.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Background drainer: reads raw tick entries from Redis Streams (sma:ticks:{sessionId})
 * and persists them to tick_data in batch.
 *
 * <p>Drain cycle (every 1 s):
 * <ol>
 *   <li>SMEMBERS sma:active:tick:sessions → active session IDs
 *   <li>For each session: drainOneBatch()
 * </ol>
 *
 * <p>drainOneBatch():
 * <ol>
 *   <li>XAUTOCLAIM — reclaim entries idle > 30 s (crash recovery)
 *   <li>XREADGROUP > — read up to 200 new undelivered messages
 *   <li>Persist to DB (INSERT ... ON CONFLICT DO NOTHING)
 *   <li>XACK
 * </ol>
 *
 * <p>Idempotency: V5 migration adds UNIQUE(instrument_token, session_id, tick_time).
 * Reprocessed messages (XAUTOCLAIM after crash) are silently skipped by ON CONFLICT DO NOTHING.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RedisTickDrainer {

    // ── Constants ─────────────────────────────────────────────────────────────

    static final String ACTIVE_SET    = "sma:active:tick:sessions";
    static final String STREAM_PREFIX = "sma:ticks:";
    static final String GROUP         = "drainer-group";
    static final String CONSUMER      = "worker-1";

    private static final int  BATCH_SIZE = 200;

    private static final String INSERT_SQL =
            "INSERT INTO tick_data " +
            "(instrument_token, symbol, exchange, ltp, volume, tick_time, session_id, provider) " +
            "VALUES (?, ?, ?, ?, ?, CAST(? AS TIMESTAMP), ?, ?) " +
            "ON CONFLICT (instrument_token, session_id, tick_time) DO NOTHING";

    // ── Dependencies ──────────────────────────────────────────────────────────

    private final StringRedisTemplate redisTemplate;
    private final JdbcTemplate        jdbcTemplate;
    private final ObjectMapper        objectMapper;

    // ── Scheduled drain ───────────────────────────────────────────────────────

    /**
     * Runs every 1 second. Iterates all active tick sessions and drains one batch each.
     * Uses fixedDelay so overlapping runs cannot occur even if a cycle is slow.
     */
    @Scheduled(fixedDelay = 1000)
    public void drain() {
        Set<String> sessions = redisTemplate.opsForSet().members(ACTIVE_SET);
        if (sessions == null || sessions.isEmpty()) return;

        for (String sessionId : sessions) {
            try {
                drainOneBatch(sessionId, STREAM_PREFIX + sessionId);
            } catch (Exception e) {
                log.warn("RedisTickDrainer: drain failed for session={}: {}", sessionId, e.getMessage());
            }
        }
    }

    // ── Core drain logic ──────────────────────────────────────────────────────

    /**
     * One drain pass for a single session stream.
     *
     * <p>Priority 1: Reclaim stale pending entries via XAUTOCLAIM (crash recovery).
     * <br>Priority 2: Read new undelivered messages via XREADGROUP.
     *
     * @return {@code true} if any messages were processed
     */
    boolean drainOneBatch(String sessionId, String streamKey) {
        // ── Step 1: Reclaim stale pending entries (XAUTOCLAIM) ────────────────
        try {
            List<MapRecord<String, Object, Object>> reclaimed = autoClaim(streamKey);
            if (!reclaimed.isEmpty()) {
                log.debug("RedisTickDrainer: autoclaim reclaimed {} entries for session={}",
                        reclaimed.size(), sessionId);
                persistAndAck(streamKey, reclaimed);
                return true;
            }
        } catch (Exception e) {
            // XAUTOCLAIM may fail if group/stream doesn't exist yet — safe to skip
            log.debug("RedisTickDrainer: autoclaim skipped for {}: {}", streamKey, e.getMessage());
        }

        // ── Step 2: Read new undelivered messages (XREADGROUP) ────────────────
        List<MapRecord<String, Object, Object>> messages = readNew(streamKey);
        if (messages == null || messages.isEmpty()) {
            return false;
        }

        persistAndAck(streamKey, messages);
        return true;
    }

    // ── Redis operations ──────────────────────────────────────────────────────

    /**
     * Reads messages already in the Pending Entry List (PEL) for worker-1 that were
     * claimed but never ACK'd — i.e. messages from before a crash/restart.
     *
     * <p>Uses {@code XREADGROUP GROUP drainer-group worker-1 COUNT 200 STREAMS key 0-0}.
     * The {@code 0-0} start ID returns messages already delivered to this consumer but
     * not yet ACK'd, which is functionally equivalent to XAUTOCLAIM for single-consumer
     * setups (Spring Data Redis 3.2 does not expose XAUTOCLAIM on StreamOperations).
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private List<MapRecord<String, Object, Object>> autoClaim(String streamKey) {
        try {
            List<?> result = redisTemplate.<Object, Object>opsForStream()
                    .read(Consumer.from(GROUP, CONSUMER),
                          StreamReadOptions.empty().count(BATCH_SIZE),
                          StreamOffset.create(streamKey, ReadOffset.from("0-0")));
            if (result == null || result.isEmpty()) return List.of();
            List<MapRecord<String, Object, Object>> messages = new ArrayList<>(result.size());
            for (Object item : result) {
                messages.add((MapRecord<String, Object, Object>) item);
            }
            return messages;
        } catch (Exception e) {
            // Group does not exist yet or stream is empty — safe to skip
            log.debug("RedisTickDrainer: autoClaim (PEL read) skipped for {}: {}", streamKey, e.getMessage());
            return List.of();
        }
    }

    /**
     * XREADGROUP GROUP drainer-group worker-1 COUNT 200 STREAMS streamKey >
     * Returns up to 200 new (undelivered) messages.
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private List<MapRecord<String, Object, Object>> readNew(String streamKey) {
        List<?> result = redisTemplate.<Object, Object>opsForStream()
                .read(Consumer.from(GROUP, CONSUMER),
                      StreamReadOptions.empty().count(BATCH_SIZE),
                      StreamOffset.create(streamKey, ReadOffset.lastConsumed()));
        if (result == null || result.isEmpty()) return List.of();
        List<MapRecord<String, Object, Object>> messages = new ArrayList<>(result.size());
        for (Object item : result) {
            messages.add((MapRecord<String, Object, Object>) item);
        }
        return messages;
    }

    // ── Persistence + ACK ─────────────────────────────────────────────────────

    private void persistAndAck(String streamKey,
                                List<MapRecord<String, Object, Object>> messages) {
        List<TickEntry>   entries   = parse(messages);
        List<RecordId>    recordIds = new ArrayList<>(messages.size());
        messages.forEach(m -> recordIds.add(m.getId()));

        if (!entries.isEmpty()) {
            batchInsert(entries);
        }

        // XACK — even if some rows were skipped via ON CONFLICT, we still ACK
        // to remove them from the PEL and prevent infinite re-claim.
        redisTemplate.opsForStream()
                .acknowledge(streamKey, GROUP, recordIds.toArray(new RecordId[0]));

        log.debug("RedisTickDrainer: persisted={} acked={} stream={}",
                entries.size(), recordIds.size(), streamKey);
    }

    // ── JSON parsing ──────────────────────────────────────────────────────────

    private List<TickEntry> parse(List<MapRecord<String, Object, Object>> messages) {
        List<TickEntry> entries = new ArrayList<>(messages.size());
        for (MapRecord<String, Object, Object> msg : messages) {
            Object dataVal = msg.getValue().get("data");
            if (dataVal == null) {
                log.warn("RedisTickDrainer: missing 'data' field in message id={}", msg.getId());
                continue;
            }
            try {
                TickEntry entry = objectMapper.readValue(dataVal.toString(), TickEntry.class);
                if (entry.getInstrumentToken() != null && entry.getTickTime() != null) {
                    entries.add(entry);
                }
            } catch (Exception e) {
                log.warn("RedisTickDrainer: failed to parse tick JSON id={}: {}", msg.getId(), e.getMessage());
            }
        }
        return entries;
    }

    // ── DB batch insert ───────────────────────────────────────────────────────

    private void batchInsert(List<TickEntry> entries) {
        jdbcTemplate.batchUpdate(INSERT_SQL, entries, entries.size(), (ps, e) -> {
            ps.setLong(1, e.getInstrumentToken());
            ps.setString(2, e.getSymbol());
            ps.setString(3, e.getExchange());
            ps.setDouble(4, e.getLtp() != null ? e.getLtp() : 0.0);
            ps.setLong(5, e.getVolume() != null ? e.getVolume() : 0L);
            ps.setString(6, e.getTickTime());     // CAST(? AS TIMESTAMP) in SQL
            ps.setString(7, e.getSessionId());
            ps.setString(8, e.getProvider() != null ? e.getProvider() : "kite");
        });
    }

    // ── DTO ───────────────────────────────────────────────────────────────────

    /**
     * Maps the "data" JSON field written by LiveTickBuffer in Strategy Engine.
     * Field names must match exactly what LiveTickBuffer serialises.
     */
    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class TickEntry {
        @JsonProperty("instrumentToken") private Long   instrumentToken;
        @JsonProperty("symbol")          private String symbol;
        @JsonProperty("exchange")        private String exchange;
        @JsonProperty("ltp")             private Double ltp;
        @JsonProperty("volume")          private Long   volume;
        /** ISO-8601 timestamp string, e.g. "2024-04-17T09:15:01.000" */
        @JsonProperty("tickTime")        private String tickTime;
        @JsonProperty("sessionId")       private String sessionId;
        @JsonProperty("provider")        private String provider;
    }
}
