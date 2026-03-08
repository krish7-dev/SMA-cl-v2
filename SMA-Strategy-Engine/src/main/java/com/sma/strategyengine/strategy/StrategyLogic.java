package com.sma.strategyengine.strategy;

/**
 * Contract for all built-in and future pluggable strategy implementations.
 *
 * Each implementation must be a Spring bean so the {@link StrategyRegistry}
 * can auto-discover it. Implementations must be stateless with respect to
 * Spring wiring — per-instance state (e.g. price history) is keyed by
 * {@code StrategyContext.instanceId} inside the implementation.
 *
 * <pre>
 * Naming convention: strategy type keys are UPPER_SNAKE_CASE strings
 * stored in strategy_instance.strategy_type (e.g. "SMA_CROSSOVER").
 * </pre>
 */
public interface StrategyLogic {

    /**
     * Unique type identifier. Must match the value stored in
     * {@code strategy_instance.strategy_type}.
     */
    String type();

    /**
     * Evaluates one candle for one strategy instance.
     *
     * @param ctx full context including candle data and configuration
     * @return a {@link StrategyResult} — never null
     */
    StrategyResult evaluate(StrategyContext ctx);

    /**
     * Called when a strategy instance is deleted or deactivated permanently.
     * Implementations should release any in-memory state for the given instanceId.
     * Default implementation is a no-op.
     */
    default void onInstanceRemoved(String instanceId) {}
}
