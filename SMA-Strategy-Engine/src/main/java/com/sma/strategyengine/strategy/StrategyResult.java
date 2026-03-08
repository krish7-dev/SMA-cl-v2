package com.sma.strategyengine.strategy;

import lombok.Value;

import java.util.Map;

/**
 * Result produced by {@link StrategyLogic#evaluate}.
 *
 * Carries the signal decision, a human-readable reason, and an optional
 * diagnostics map (e.g. indicator values) that gets persisted to signal_record.meta.
 */
@Value
public class StrategyResult {

    public enum Signal { BUY, SELL, HOLD }

    Signal              signal;
    String              reason;
    Map<String, Object> meta;

    // ─── Factory methods ──────────────────────────────────────────────────────

    public static StrategyResult buy(String reason, Map<String, Object> meta) {
        return new StrategyResult(Signal.BUY, reason, meta);
    }

    public static StrategyResult sell(String reason, Map<String, Object> meta) {
        return new StrategyResult(Signal.SELL, reason, meta);
    }

    public static StrategyResult hold(String reason) {
        return new StrategyResult(Signal.HOLD, reason, Map.of());
    }

    public static StrategyResult hold(String reason, Map<String, Object> meta) {
        return new StrategyResult(Signal.HOLD, reason, meta);
    }

    // ─── Convenience ──────────────────────────────────────────────────────────

    public boolean isBuy()  { return signal == Signal.BUY; }
    public boolean isSell() { return signal == Signal.SELL; }
    public boolean isHold() { return signal == Signal.HOLD; }
    public boolean isActionable() { return !isHold(); }
}
