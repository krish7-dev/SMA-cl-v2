package com.sma.strategyengine.service;

import com.sma.strategyengine.strategy.PositionDirection;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory store of per-instance position direction (FLAT / LONG / SHORT).
 *
 * Kept as a standalone component to avoid circular dependencies between
 * {@link EvaluationService} and {@link StrategyService}.
 *
 * State is lost on service restart — instances resume with FLAT direction.
 */
@Component
public class PositionTracker {

    private final ConcurrentHashMap<String, PositionDirection> directions = new ConcurrentHashMap<>();

    public PositionDirection getDirection(String instanceId) {
        return directions.getOrDefault(instanceId, PositionDirection.FLAT);
    }

    public void setDirection(String instanceId, PositionDirection direction) {
        directions.put(instanceId, direction);
    }

    public void reset(String instanceId) {
        directions.remove(instanceId);
    }
}
