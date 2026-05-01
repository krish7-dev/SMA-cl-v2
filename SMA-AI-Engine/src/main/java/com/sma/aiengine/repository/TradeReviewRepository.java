package com.sma.aiengine.repository;

import com.sma.aiengine.entity.TradeReviewRecord;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface TradeReviewRepository extends JpaRepository<TradeReviewRecord, Long> {

    Optional<TradeReviewRecord> findBySessionIdAndTradeId(String sessionId, String tradeId);

    List<TradeReviewRecord> findBySessionIdOrderByCreatedAtDesc(String sessionId);

    List<TradeReviewRecord> findBySymbolOrderByCreatedAtDesc(String symbol);

    List<TradeReviewRecord> findBySessionIdAndSymbolOrderByCreatedAtDesc(String sessionId, String symbol);

    List<TradeReviewRecord> findAllByOrderByCreatedAtDesc();
}
