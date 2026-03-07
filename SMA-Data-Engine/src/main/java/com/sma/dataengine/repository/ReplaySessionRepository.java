package com.sma.dataengine.repository;

import com.sma.dataengine.entity.ReplaySession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface ReplaySessionRepository extends JpaRepository<ReplaySession, Long> {

    Optional<ReplaySession> findBySessionId(String sessionId);

    List<ReplaySession> findByRequestedByOrderByCreatedAtDesc(String userId);

    List<ReplaySession> findByStatusOrderByCreatedAtDesc(ReplaySession.Status status);
}
