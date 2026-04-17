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
}
