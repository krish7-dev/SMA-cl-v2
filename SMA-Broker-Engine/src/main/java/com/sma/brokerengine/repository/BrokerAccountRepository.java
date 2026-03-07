package com.sma.brokerengine.repository;

import com.sma.brokerengine.entity.BrokerAccount;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface BrokerAccountRepository extends JpaRepository<BrokerAccount, Long> {

    Optional<BrokerAccount> findByUserIdAndBrokerName(String userId, String brokerName);

    List<BrokerAccount> findAllByUserId(String userId);

    boolean existsByUserIdAndBrokerName(String userId, String brokerName);
}
