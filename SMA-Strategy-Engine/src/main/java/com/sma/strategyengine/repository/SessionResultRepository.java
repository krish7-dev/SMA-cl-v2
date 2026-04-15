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
     * Upserts a feed chunk into the session_result row.
     * On the first call (no row exists) it inserts with an empty metadata skeleton.
     * On subsequent calls it appends the new-candle JSON array to the existing feed_json via
     * PostgreSQL JSONB concatenation — so each flush only transfers new candles, not the full day.
     *
     * @param chunk  JSON array string of new candle events, e.g. [{...},{...}]
     */
    @Modifying
    @Transactional
    @Query(value = """
        INSERT INTO session_result
            (session_id, type, user_id, broker_name, session_date, label, feed_json, saved_at)
        VALUES
            (:sessionId, 'LIVE', :userId, :brokerName, CAST(:sessionDate AS DATE), '', :chunk, NOW())
        ON CONFLICT (session_id) DO UPDATE
        SET feed_json = (COALESCE(session_result.feed_json, '[]')::jsonb || :chunk::jsonb)::text,
            saved_at  = NOW()
        """, nativeQuery = true)
    void appendFeedChunk(
            @Param("sessionId")   String sessionId,
            @Param("userId")      String userId,
            @Param("brokerName")  String brokerName,
            @Param("sessionDate") String sessionDate,
            @Param("chunk")       String chunk);

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
            saved_at           = NOW()
        WHERE session_id = :sessionId
        """, nativeQuery = true)
    void updateMetadata(
            @Param("sessionId")        String sessionId,
            @Param("closedTradesJson") String closedTradesJson,
            @Param("summaryJson")      String summaryJson,
            @Param("configJson")       String configJson);
}
