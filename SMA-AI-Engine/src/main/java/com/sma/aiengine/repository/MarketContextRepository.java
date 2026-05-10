package com.sma.aiengine.repository;

import com.sma.aiengine.entity.MarketContextRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface MarketContextRepository extends JpaRepository<MarketContextRecord, Long> {

    Optional<MarketContextRecord> findBySessionIdAndCandleTime(String sessionId, Instant candleTime);

    List<MarketContextRecord> findBySessionIdOrderByCandleTimeDesc(String sessionId);

    @Query("SELECT m.sessionId, COUNT(m), MAX(m.createdAt) FROM MarketContextRecord m WHERE m.sessionId IS NOT NULL GROUP BY m.sessionId")
    List<Object[]> findSessionSummaries();
}
