package com.sma.executionengine.repository;

import com.sma.executionengine.entity.ExecutionRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface ExecutionRepository extends JpaRepository<ExecutionRecord, Long> {

    Optional<ExecutionRecord> findByIntentId(String intentId);

    Optional<ExecutionRecord> findByBrokerClientOrderId(String brokerClientOrderId);

    List<ExecutionRecord> findByUserIdAndBrokerNameOrderByCreatedAtDesc(String userId, String brokerName);

    List<ExecutionRecord> findByUserIdOrderByCreatedAtDesc(String userId);
}
