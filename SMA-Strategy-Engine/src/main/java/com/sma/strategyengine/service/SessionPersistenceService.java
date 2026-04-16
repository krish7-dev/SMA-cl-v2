package com.sma.strategyengine.service;

import com.sma.strategyengine.repository.SessionResultRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Service;

/**
 * Wraps session_result DB writes with retry logic so transient DB connection issues
 * (e.g. Supabase pool exhaustion at market open) never lose data or crash the app.
 *
 * Retry policy: up to 5 attempts with exponential backoff starting at 2s, capped at 30s.
 * If all 5 attempts fail the exception propagates — flushFeed() catches it and the next
 * heartbeat will retry the full pending batch automatically.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SessionPersistenceService {

    private final SessionResultRepository repository;

    @Retryable(
            retryFor = Exception.class,
            maxAttempts = 5,
            backoff = @Backoff(delay = 2000, multiplier = 2.0, maxDelay = 30000)
    )
    public void appendFeedChunk(String sessionId, String userId, String brokerName,
                                String sessionDate, String chunk) {
        repository.appendFeedChunk(sessionId, userId, brokerName, sessionDate, chunk);
    }

    @Retryable(
            retryFor = Exception.class,
            maxAttempts = 5,
            backoff = @Backoff(delay = 2000, multiplier = 2.0, maxDelay = 30000)
    )
    public void updateMetadata(String sessionId, String closedTradesJson,
                               String summaryJson, String configJson, String label) {
        repository.updateMetadata(sessionId, closedTradesJson, summaryJson, configJson, label);
    }
}
