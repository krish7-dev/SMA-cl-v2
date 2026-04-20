package com.sma.strategyengine.service;

import com.sma.strategyengine.entity.SessionFeedChunkRecord;
import com.sma.strategyengine.repository.SessionFeedChunkRepository;
import com.sma.strategyengine.repository.SessionResultRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;

/**
 * Wraps session_result / session_feed_chunk DB writes with retry logic so transient
 * DB connection issues never lose data or crash the app.
 *
 * Feed chunks are written to the {@code session_feed_chunk} table (O(1) INSERT each time)
 * rather than appending to a growing JSONB column in {@code session_result}.
 * The old JSONB-append pattern caused 13-110 second queries by end-of-day as the document grew.
 *
 * Retry policy: up to 5 attempts, exponential backoff 2 s → 30 s.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SessionPersistenceService {

    private final SessionResultRepository   sessionResultRepository;
    private final SessionFeedChunkRepository chunkRepository;

    /**
     * Ensures the session_result header row exists, then inserts one chunk row.
     * Each call is a simple O(1) INSERT — no JSONB concatenation.
     */
    @Retryable(
            retryFor = Exception.class,
            maxAttempts = 5,
            backoff = @Backoff(delay = 2000, multiplier = 2.0, maxDelay = 30000)
    )
    public void appendFeedChunk(String sessionId, String userId, String brokerName,
                                String sessionDate, String chunk) {
        // Upsert the header row (no-op on conflict, updates saved_at)
        sessionResultRepository.ensureSessionRow(sessionId, userId, brokerName, sessionDate);

        // Insert the chunk — plain INSERT, always O(1) regardless of session size
        chunkRepository.save(SessionFeedChunkRecord.builder()
                .sessionId(sessionId)
                .chunkJson(chunk)
                .savedAt(Instant.now())
                .build());
    }

    @Retryable(
            retryFor = Exception.class,
            maxAttempts = 5,
            backoff = @Backoff(delay = 2000, multiplier = 2.0, maxDelay = 30000)
    )
    public void updateMetadata(String sessionId, String closedTradesJson,
                               String summaryJson, String configJson, String label) {
        sessionResultRepository.updateMetadata(sessionId, closedTradesJson, summaryJson, configJson, label);
    }

    /**
     * Idempotent feed chunk insert for the Redis-Stream drainer.
     * Uses ON CONFLICT (session_id, stream_last_id) DO NOTHING so that
     * re-drained batches (after crash before XACK) are silently skipped.
     *
     * @param streamLastId "firstMessageId:lastMessageId" batch dedup key
     */
    @Retryable(
            retryFor = Exception.class,
            maxAttempts = 5,
            backoff = @Backoff(delay = 2000, multiplier = 2.0, maxDelay = 30000)
    )
    public void appendFeedChunkIdempotent(String sessionId, String userId, String brokerName,
                                          String sessionDate, String chunkJson, String streamLastId) {
        sessionResultRepository.ensureSessionRow(sessionId, userId, brokerName, sessionDate);
        chunkRepository.insertIdempotent(sessionId, chunkJson, streamLastId);
    }

    /**
     * Assembles the full feed JSON array from all chunk rows for a session.
     * Returns {@code null} if no chunks exist.
     * Called by OptionsLiveService.getFeed() after drainFully() to reconstruct
     * the candle-event timeline from DB.
     */
    public String assembleFeedJson(String sessionId) {
        List<SessionFeedChunkRecord> chunks =
                chunkRepository.findBySessionIdOrderByIdAsc(sessionId);
        if (chunks.isEmpty()) return null;

        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (SessionFeedChunkRecord chunk : chunks) {
            String json = chunk.getChunkJson().trim();
            if (json.startsWith("[") && json.endsWith("]")) {
                json = json.substring(1, json.length() - 1).trim();
            }
            if (!json.isEmpty()) {
                if (!first) sb.append(",");
                sb.append(json);
                first = false;
            }
        }
        sb.append("]");
        return sb.toString();
    }
}
