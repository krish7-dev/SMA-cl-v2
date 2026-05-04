package com.sma.strategyengine.repository;

import com.sma.strategyengine.entity.SessionFeedChunkRecord;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

public interface SessionFeedChunkRepository extends JpaRepository<SessionFeedChunkRecord, Long> {

    /** Returns all chunks for a session in insertion order — used to reassemble the full feed. */
    List<SessionFeedChunkRecord> findBySessionIdOrderByIdAsc(String sessionId);

    /** Deletes all chunks for a session (called when the session_result row is deleted). */
    @Modifying
    @Transactional
    @Query("DELETE FROM SessionFeedChunkRecord c WHERE c.sessionId = :sessionId")
    void deleteBySessionId(@Param("sessionId") String sessionId);

    /** True if any chunk exists for this session — used to decide whether to assemble. */
    boolean existsBySessionId(String sessionId);

    /**
     * Cursor-based fetch: returns up to {@code pageable.pageSize} chunks with id > afterId, ordered ASC.
     * Use last returned id as afterId in subsequent calls to walk forward without offset pagination.
     * Prefer this over assembleFeedJsonNative for UI/API responses.
     */
    @Query("SELECT c FROM SessionFeedChunkRecord c WHERE c.sessionId = :sessionId AND c.id > :afterId ORDER BY c.id ASC")
    List<SessionFeedChunkRecord> findBySessionIdAfterIdOrderByIdAsc(
            @Param("sessionId") String sessionId,
            @Param("afterId")   Long afterId,
            Pageable pageable);

    /**
     * Assembles the full feed JSON array entirely in PostgreSQL.
     * Explodes each chunk's JSON array into individual elements, re-aggregates them
     * ordered by chunk id, and returns one JSON array string.
     * Avoids loading all chunk entities into Java heap (prevents OOM on long sessions).
     * Returns null if no chunks exist for the session.
     *
     * <p><b>WARNING — heavy path:</b> can return 100+ MB for large sessions.
     * Use the cursor-based {@link #findBySessionIdAfterIdOrderByIdAsc} endpoint for UI/API access.
     * This method is retained for server-side divergence analysis only.
     */
    @Query(value = """
            SELECT COALESCE(json_agg(elem ORDER BY c.id ASC)::text, '[]')
            FROM session_feed_chunk c,
                 json_array_elements(c.chunk_json::json) AS elem
            WHERE c.session_id = :sessionId
            """, nativeQuery = true)
    String assembleFeedJsonNative(@Param("sessionId") String sessionId);

    /**
     * Idempotent insert used by the Redis-Stream drainer.
     * ON CONFLICT on (session_id, stream_last_id) means a batch that is re-drained
     * after a crash (before XACK was written) is silently skipped.
     *
     * @param streamLastId "firstMessageId:lastMessageId" — uniquely identifies the batch
     */
    @Modifying
    @Transactional
    @Query(value = """
            INSERT INTO session_feed_chunk (session_id, chunk_json, saved_at, stream_last_id)
            VALUES (:sessionId, :chunkJson, NOW(), :streamLastId)
            ON CONFLICT (session_id, stream_last_id) DO NOTHING
            """, nativeQuery = true)
    void insertIdempotent(@Param("sessionId")    String sessionId,
                          @Param("chunkJson")    String chunkJson,
                          @Param("streamLastId") String streamLastId);
}
