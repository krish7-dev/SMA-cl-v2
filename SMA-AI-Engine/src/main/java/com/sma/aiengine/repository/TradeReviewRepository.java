package com.sma.aiengine.repository;

import com.sma.aiengine.entity.TradeReviewRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.Optional;

public interface TradeReviewRepository extends JpaRepository<TradeReviewRecord, Long> {

    Optional<TradeReviewRecord> findBySessionIdAndTradeId(String sessionId, String tradeId);

    List<TradeReviewRecord> findBySessionIdOrderByCreatedAtAsc(String sessionId);

    List<TradeReviewRecord> findBySymbolOrderByCreatedAtAsc(String symbol);

    List<TradeReviewRecord> findBySessionIdAndSymbolOrderByCreatedAtAsc(String sessionId, String symbol);

    List<TradeReviewRecord> findAllByOrderByCreatedAtAsc();

    @Query("SELECT r.sessionId, COUNT(r), MAX(r.createdAt) FROM TradeReviewRecord r WHERE r.sessionId IS NOT NULL GROUP BY r.sessionId")
    List<Object[]> findSessionSummaries();
}
