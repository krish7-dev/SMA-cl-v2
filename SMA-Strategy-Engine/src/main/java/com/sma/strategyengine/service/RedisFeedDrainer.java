package com.sma.strategyengine.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.connection.stream.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Background drainer: reads feed events from Redis Streams (sma:feed:{sessionId})
 * and persists them to session_feed_chunk in batch.
 *
 * <p>Drain cycle (every 2 s via {@link #drainAll}):
 * <ol>
 *   <li>SMEMBERS sma:active:feed:sessions → active session IDs
 *   <li>For each session: {@link #drainOneBatch}
 * </ol>
 *
 * <p>{@link #drainOneBatch} flow:
 * <ol>
 *   <li>XAUTOCLAIM — reclaim entries idle > 30 s (crash recovery path)
 *   <li>XREADGROUP > — read up to 200 new undelivered messages
 *   <li>Build chunk JSON, compute dedup key "firstId:lastId"
 *   <li>appendFeedChunkIdempotent → ON CONFLICT (session_id, stream_last_id) DO NOTHING
 *   <li>XACK
 * </ol>
 *
 * <p>{@link #drainFully} is called by OptionsLiveService on stop / autoSave.
 * It loops drainOneBatch until empty or the caller-supplied limits are hit.
 *
 * <p><b>Active-set contract:</b> sessions are NEVER removed from
 * {@value #ACTIVE_FEED_SET} by this drainer — only by explicit stop() or
 * orphan cleanup. A live session can have zero pending messages between cycles;
 * that does not mean the session is finished.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RedisFeedDrainer {

    // ── Constants ─────────────────────────────────────────────────────────────

    static final String ACTIVE_FEED_SET  = "sma:active:feed:sessions";
    static final String FEED_STREAM_PFX  = "sma:feed:";
    public static final String META_KEY_PFX = "sma:feed-meta:";
    static final String GROUP            = "drainer-group";
    static final String CONSUMER         = "worker-1";

    private static final int  BATCH_SIZE = 200;

    // ── Dependencies ──────────────────────────────────────────────────────────

    private final StringRedisTemplate   redisTemplate;
    private final SessionPersistenceService persistenceService;

    // ── Scheduled drain ───────────────────────────────────────────────────────

    /** Runs every 2 seconds. Processes one batch per active session per cycle. */
    @Scheduled(fixedDelay = 2000)
    public void drainAll() {
        Set<String> sessions = redisTemplate.opsForSet().members(ACTIVE_FEED_SET);
        if (sessions == null || sessions.isEmpty()) return;

        for (String sessionId : sessions) {
            try {
                drainOneBatch(sessionId, FEED_STREAM_PFX + sessionId);
            } catch (Exception e) {
                log.warn("RedisFeedDrainer: drain failed session={}: {}", sessionId, e.getMessage());
            }
        }
    }

    // ── Public: bounded full drain ────────────────────────────────────────────

    /**
     * Drains up to {@code maxBatches} batches within {@code maxDuration}.
     * Called on session stop and autoSave to flush pending entries before metadata is written.
     *
     * @return {@code true} if the stream was fully drained; {@code false} if limits were hit
     */
    public boolean drainFully(String sessionId, int maxBatches, Duration maxDuration) {
        String streamKey = FEED_STREAM_PFX + sessionId;
        Instant deadline = Instant.now().plus(maxDuration);
        int batches = 0;

        while (batches < maxBatches && Instant.now().isBefore(deadline)) {
            try {
                boolean hadItems = drainOneBatch(sessionId, streamKey);
                if (!hadItems) return true;  // stream fully drained
                batches++;
            } catch (Exception e) {
                log.warn("RedisFeedDrainer.drainFully: batch {} failed for session={}: {}",
                        batches, sessionId, e.getMessage());
                batches++;
            }
        }

        log.warn("RedisFeedDrainer.drainFully: limit reached (batches={}, session={}). " +
                 "Background drainer will continue.", batches, sessionId);
        return false;
    }

    // ── Core drain logic ──────────────────────────────────────────────────────

    /**
     * One drain pass for a single session stream.
     * Priority 1: Reclaim stale pending entries (XAUTOCLAIM — crash recovery).
     * Priority 2: Read new undelivered messages (XREADGROUP >).
     *
     * @return {@code true} if any messages were processed
     */
    boolean drainOneBatch(String sessionId, String streamKey) {
        // ── Step 1: Reclaim stale pending entries ─────────────────────────────
        try {
            List<MapRecord<String, Object, Object>> reclaimed = autoClaim(streamKey);
            if (!reclaimed.isEmpty()) {
                log.debug("RedisFeedDrainer: autoclaim reclaimed {} entries session={}",
                        reclaimed.size(), sessionId);
                persistAndAck(sessionId, streamKey, reclaimed);
                return true;
            }
        } catch (Exception e) {
            log.debug("RedisFeedDrainer: autoclaim skipped for {}: {}", streamKey, e.getMessage());
        }

        // ── Step 2: Read new undelivered messages ─────────────────────────────
        List<MapRecord<String, Object, Object>> messages = readNew(streamKey);
        if (messages == null || messages.isEmpty()) return false;

        persistAndAck(sessionId, streamKey, messages);
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
            log.debug("autoClaim (PEL read) skipped for {}: {}", streamKey, e.getMessage());
            return List.of();
        }
    }

    /** XREADGROUP GROUP drainer-group worker-1 COUNT 200 STREAMS streamKey > */
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

    // ── Persist + ACK ─────────────────────────────────────────────────────────

    private void persistAndAck(String sessionId, String streamKey,
                                List<MapRecord<String, Object, Object>> messages) {
        // Resolve session meta for ensureSessionRow
        String metaKey    = META_KEY_PFX + sessionId;
        String userId      = resolveMetaField(metaKey, "userId",      sessionId);
        String brokerName  = resolveMetaField(metaKey, "brokerName",  "unknown");
        String sessionDate = resolveMetaField(metaKey, "sessionDate", LocalDate.now().toString());

        // Build chunk JSON and compute dedup key
        List<String>   eventJsons = new ArrayList<>(messages.size());
        List<RecordId> recordIds  = new ArrayList<>(messages.size());
        RecordId firstId = null, lastId = null;

        for (MapRecord<String, Object, Object> msg : messages) {
            Object data = msg.getValue().get("data");
            if (data != null && !data.toString().isBlank()) {
                eventJsons.add(data.toString());
            }
            recordIds.add(msg.getId());
            if (firstId == null) firstId = msg.getId();
            lastId = msg.getId();
        }

        if (!eventJsons.isEmpty() && firstId != null) {
            String chunkJson    = "[" + String.join(",", eventJsons) + "]";
            // "firstId:lastId" — uniquely identifies this exact batch for idempotent re-drain
            String streamLastId = firstId.getValue() + ":" + lastId.getValue();

            persistenceService.appendFeedChunkIdempotent(
                    sessionId, userId, brokerName, sessionDate, chunkJson, streamLastId);
        }

        // XACK — always ACK, even if all messages had null/empty data, so they leave the PEL
        redisTemplate.opsForStream()
                .acknowledge(streamKey, GROUP, recordIds.toArray(new RecordId[0]));

        log.debug("RedisFeedDrainer: persisted={} acked={} session={}",
                eventJsons.size(), recordIds.size(), sessionId);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String resolveMetaField(String metaKey, String field, String defaultVal) {
        try {
            Object val = redisTemplate.opsForHash().get(metaKey, field);
            return (val != null) ? val.toString() : defaultVal;
        } catch (Exception e) {
            return defaultVal;
        }
    }
}
