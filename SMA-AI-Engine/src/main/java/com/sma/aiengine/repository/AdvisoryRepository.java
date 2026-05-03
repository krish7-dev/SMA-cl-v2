package com.sma.aiengine.repository;

import com.sma.aiengine.entity.AdvisoryRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.Optional;

public interface AdvisoryRepository extends JpaRepository<AdvisoryRecord, Long> {

    List<AdvisoryRecord> findBySessionIdOrderByCreatedAtAsc(String sessionId);

    List<AdvisoryRecord> findBySymbolOrderByCreatedAtAsc(String symbol);

    List<AdvisoryRecord> findBySessionIdAndSymbolOrderByCreatedAtAsc(String sessionId, String symbol);

    List<AdvisoryRecord> findAllByOrderByCreatedAtAsc();

    Optional<AdvisoryRecord> findBySessionIdAndCandleTime(String sessionId, java.time.Instant candleTime);

    @Query("SELECT a.sessionId, COUNT(a), MAX(a.createdAt) FROM AdvisoryRecord a WHERE a.sessionId IS NOT NULL GROUP BY a.sessionId")
    List<Object[]> findSessionSummaries();

    @Query("SELECT a.sessionId, a.aiModel, a.aiApiMode, a.aiPromptMode, COUNT(a), MAX(a.createdAt) " +
           "FROM AdvisoryRecord a WHERE a.sessionId IS NOT NULL " +
           "GROUP BY a.sessionId, a.aiModel, a.aiApiMode, a.aiPromptMode " +
           "ORDER BY MAX(a.createdAt) DESC")
    List<Object[]> findExperimentSummaries();
}
