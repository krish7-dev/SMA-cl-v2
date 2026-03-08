package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Auto-discovers all {@link StrategyLogic} beans and indexes them by type key.
 *
 * Adding a new strategy only requires creating a Spring bean that implements
 * {@link StrategyLogic} — no registration code is needed here.
 */
@Slf4j
@Component
public class StrategyRegistry {

    private final Map<String, StrategyLogic> strategies;

    public StrategyRegistry(List<StrategyLogic> allStrategies) {
        this.strategies = allStrategies.stream()
                .collect(Collectors.toMap(StrategyLogic::type, Function.identity()));
        log.info("Strategy registry initialised with {} strategy type(s): {}",
                strategies.size(), strategies.keySet());
    }

    /**
     * Resolves a strategy by its type key.
     *
     * @throws IllegalArgumentException if the type is not registered
     */
    public StrategyLogic resolve(String type) {
        StrategyLogic logic = strategies.get(type);
        if (logic == null) {
            throw new IllegalArgumentException(
                    "Unknown strategy type: '" + type + "'. Available: " + strategies.keySet());
        }
        return logic;
    }

    /** Returns all registered strategy type keys. */
    public Set<String> availableTypes() {
        return strategies.keySet();
    }

    /** Returns true if the given type is registered. */
    public boolean isKnownType(String type) {
        return strategies.containsKey(type);
    }
}
