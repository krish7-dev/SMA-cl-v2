package com.sma.aiengine.repository;

import com.sma.aiengine.entity.AdvisoryRecord;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface AdvisoryRepository extends JpaRepository<AdvisoryRecord, Long> {

    List<AdvisoryRecord> findBySessionIdOrderByCreatedAtAsc(String sessionId);

    List<AdvisoryRecord> findBySymbolOrderByCreatedAtAsc(String symbol);

    List<AdvisoryRecord> findBySessionIdAndSymbolOrderByCreatedAtAsc(String sessionId, String symbol);

    List<AdvisoryRecord> findAllByOrderByCreatedAtAsc();
}
