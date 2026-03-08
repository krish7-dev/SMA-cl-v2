package com.sma.strategyengine.repository;

import com.sma.strategyengine.entity.StrategyInstance;
import com.sma.strategyengine.entity.StrategyInstance.Status;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface StrategyInstanceRepository extends JpaRepository<StrategyInstance, Long> {

    Optional<StrategyInstance> findByInstanceId(String instanceId);

    List<StrategyInstance> findByUserIdOrderByCreatedAtDesc(String userId);

    List<StrategyInstance> findByUserIdAndStatusOrderByCreatedAtDesc(String userId, Status status);

    /** Used during market data evaluation to find all active instances for an instrument. */
    List<StrategyInstance> findBySymbolAndExchangeAndStatus(String symbol, String exchange, Status status);
}
