package com.sma.aiengine.repository;

import com.sma.aiengine.entity.AdvisoryRecord;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface AdvisoryRepository extends JpaRepository<AdvisoryRecord, Long> {

    List<AdvisoryRecord> findBySessionIdOrderByCreatedAtDesc(String sessionId);

    List<AdvisoryRecord> findBySymbolOrderByCreatedAtDesc(String symbol);

    List<AdvisoryRecord> findBySessionIdAndSymbolOrderByCreatedAtDesc(String sessionId, String symbol);

    List<AdvisoryRecord> findAllByOrderByCreatedAtDesc();
}
