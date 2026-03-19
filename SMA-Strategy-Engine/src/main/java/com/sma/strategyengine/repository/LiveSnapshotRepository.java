package com.sma.strategyengine.repository;

import com.sma.strategyengine.entity.LiveSnapshotRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface LiveSnapshotRepository extends JpaRepository<LiveSnapshotRecord, Long> {
    Optional<LiveSnapshotRecord> findByUserIdAndBrokerName(String userId, String brokerName);
    void deleteByUserIdAndBrokerName(String userId, String brokerName);
}
