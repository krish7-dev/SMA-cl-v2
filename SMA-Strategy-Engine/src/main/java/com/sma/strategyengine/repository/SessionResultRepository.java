package com.sma.strategyengine.repository;

import com.sma.strategyengine.entity.SessionResultRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

public interface SessionResultRepository extends JpaRepository<SessionResultRecord, String> {

    /** Returns all sessions for a user, newest first. Feed/trade JSON NOT loaded (use findById for that). */
    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.savedAt) " +
           "FROM SessionResultRecord r WHERE r.userId = :userId ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findMetadataByUserId(@Param("userId") String userId);

    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.savedAt) " +
           "FROM SessionResultRecord r WHERE r.userId = :userId AND r.type = :type ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findMetadataByUserIdAndType(@Param("userId") String userId, @Param("type") String type);

    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.savedAt) " +
           "FROM SessionResultRecord r WHERE r.type = :type ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findMetadataByType(@Param("type") String type);

    @Query("SELECT new SessionResultRecord(r.sessionId, r.type, r.userId, r.brokerName, r.sessionDate, r.label, null, null, null, null, r.summaryJson, r.savedAt) " +
           "FROM SessionResultRecord r ORDER BY r.sessionDate DESC, r.savedAt DESC")
    List<SessionResultRecord> findAllMetadata();

    @Transactional
    void deleteBySessionId(String sessionId);
}
