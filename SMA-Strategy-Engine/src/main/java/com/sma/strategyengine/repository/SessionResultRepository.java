package com.sma.strategyengine.repository;

import com.sma.strategyengine.entity.SessionResultRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

public interface SessionResultRepository extends JpaRepository<SessionResultRecord, String> {

    /** Returns all sessions for a user, newest first. Feed/trade JSON NOT loaded (use findById for that). */
    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.tickCount, r.savedAt) " +
           "FROM SessionResultRecord r WHERE r.userId = :userId ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findMetadataByUserId(@Param("userId") String userId);

    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.tickCount, r.savedAt) " +
           "FROM SessionResultRecord r WHERE r.userId = :userId AND r.type = :type ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findMetadataByUserIdAndType(@Param("userId") String userId, @Param("type") String type);

    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.tickCount, r.savedAt) " +
           "FROM SessionResultRecord r WHERE r.type = :type ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findMetadataByType(@Param("type") String type);

    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.tickCount, r.savedAt) " +
           "FROM SessionResultRecord r ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findAllMetadata();

    @Transactional
    void deleteBySessionId(String sessionId);

    /**
     * Ensures a session_result header row exists for this session.
     * Called before inserting each feed chunk into session_feed_chunk.
     * Does NOT touch feed_json — chunks are stored separately to avoid the
     * JSONB-concatenation performance regression that caused 13-110 s queries.
     */
    @Modifying
    @Transactional
    @Query(value = """
        INSERT INTO session_result
            (session_id, type, user_id, broker_name, session_date, label, saved_at)
        VALUES
            (:sessionId, 'LIVE', :userId, :brokerName, CAST(:sessionDate AS DATE), '', NOW())
        ON CONFLICT (session_id) DO UPDATE
        SET saved_at = NOW()
        """, nativeQuery = true)
    void ensureSessionRow(
            @Param("sessionId")   String sessionId,
            @Param("userId")      String userId,
            @Param("brokerName")  String brokerName,
            @Param("sessionDate") String sessionDate);

    /**
     * Updates the metadata fields of an existing session_result row.
     * Called by autoSave() after all feed chunks have been flushed.
     */
    @Modifying
    @Transactional
    @Query(value = """
        UPDATE session_result
        SET closed_trades_json = :closedTradesJson,
            summary_json       = :summaryJson,
            config_json        = :configJson,
            label              = COALESCE(NULLIF(:label, ''), label),
            saved_at           = NOW()
        WHERE session_id = :sessionId
        """, nativeQuery = true)
    void updateMetadata(
            @Param("sessionId")        String sessionId,
            @Param("closedTradesJson") String closedTradesJson,
            @Param("summaryJson")      String summaryJson,
            @Param("configJson")       String configJson,
            @Param("label")            String label);
}
