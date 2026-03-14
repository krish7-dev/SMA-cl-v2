package com.sma.strategyengine.strategy;

import lombok.Builder;
import lombok.Value;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;

import com.sma.strategyengine.strategy.PositionDirection;

/**
 * Immutable snapshot passed to {@link StrategyLogic#evaluate} on each candle.
 *
 * Contains everything a strategy needs to make a decision: instrument details,
 * execution parameters, the current candle, and its own configuration.
 */
@Value
@Builder
public class StrategyContext {

    // ─── Instance identity ────────────────────────────────────────────────────

    String instanceId;
    String strategyType;
    String userId;
    String brokerName;

    // ─── Instrument ───────────────────────────────────────────────────────────

    String symbol;
    String exchange;

    // ─── Order parameters forwarded to Execution Engine on a signal ───────────

    String  product;    // MIS / CNC / NRML
    int     quantity;
    String  orderType;  // MARKET / LIMIT

    // ─── Position state ───────────────────────────────────────────────────────

    /** Current directional position of this instance (FLAT / LONG / SHORT). */
    PositionDirection currentDirection;

    /** Whether this instance is allowed to open short positions. */
    boolean allowShorting;

    // ─── Current candle ───────────────────────────────────────────────────────

    Instant    candleOpenTime;
    BigDecimal candleOpen;
    BigDecimal candleHigh;
    BigDecimal candleLow;
    BigDecimal candleClose;
    long       candleVolume;

    // ─── Strategy configuration ───────────────────────────────────────────────

    /** Key-value parameters specific to the strategy type. */
    Map<String, String> params;

    // ─── Helpers ──────────────────────────────────────────────────────────────

    public int paramInt(String key, int defaultValue) {
        String v = params.get(key);
        if (v == null || v.isBlank()) return defaultValue;
        try { return Integer.parseInt(v.trim()); }
        catch (NumberFormatException e) { return defaultValue; }
    }

    public double paramDouble(String key, double defaultValue) {
        String v = params.get(key);
        if (v == null || v.isBlank()) return defaultValue;
        try { return Double.parseDouble(v.trim()); }
        catch (NumberFormatException e) { return defaultValue; }
    }
}
