package com.sma.strategyengine.repository;

import com.sma.strategyengine.entity.SignalRecord;
import com.sma.strategyengine.entity.SignalRecord.Signal;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;

public interface SignalRecordRepository extends JpaRepository<SignalRecord, Long> {

    List<SignalRecord> findByInstanceIdOrderByCreatedAtDesc(String instanceId);

    List<SignalRecord> findBySymbolAndExchangeOrderByCreatedAtDesc(String symbol, String exchange);

    List<SignalRecord> findByInstanceIdAndSignalOrderByCreatedAtDesc(String instanceId, Signal signal);

    List<SignalRecord> findByInstanceIdAndCreatedAtAfterOrderByCreatedAtDesc(String instanceId, Instant after);
}
