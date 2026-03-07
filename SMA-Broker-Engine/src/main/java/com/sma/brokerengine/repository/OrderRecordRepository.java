package com.sma.brokerengine.repository;

import com.sma.brokerengine.entity.OrderRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface OrderRecordRepository extends JpaRepository<OrderRecord, Long> {

    Optional<OrderRecord> findByClientOrderId(String clientOrderId);

    Optional<OrderRecord> findByBrokerOrderId(String brokerOrderId);

    boolean existsByClientOrderId(String clientOrderId);

    List<OrderRecord> findAllByBrokerAccountId(Long brokerAccountId);

    List<OrderRecord> findAllByBrokerAccountIdAndStatus(Long brokerAccountId, OrderRecord.OrderStatus status);
}
