package com.sma.strategyengine.repository;

import com.sma.strategyengine.entity.SessionFeedChunkRecord;
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
