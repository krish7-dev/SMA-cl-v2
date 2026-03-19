package com.sma.strategyengine.model.response;

import com.sma.strategyengine.service.StrategyScorer;
import lombok.Builder;
import lombok.Value;

import java.util.List;
import java.util.Map;

/**
 * Per-candle SSE event payload emitted by the Replay Evaluation endpoint.
 *
 * Each event represents one completed candle and carries:
 * - Raw OHLCV data
 * - Detected regime (if regime detection is enabled)
 * - Per-strategy signals (BUY / SELL / HOLD)
 * - Trade actions taken on this candle (entry/exit per strategy)
 * - Signals blocked by trading rules
 * - Combined pool actions (when scoreConfig is enabled)
 * - Snapshot of every strategy's capital/position/trades/equity
 * - Progress counters
 */
@Value
@Builder
public class ReplayCandleEvent {

    // ─── Candle data ──────────────────────────────────────────────────────────

    String candleTime;
    double open;
    double high;
    double low;
    double close;
    double volume;

    // ─── Evaluation results ───────────────────────────────────────────────────

    /** Regime detected for this candle; null when regime detection is disabled. */
    String regime;

    /** Strategy label → signal ("BUY" / "SELL" / "HOLD"). */
    Map<String, String> signals;

    /** Trades executed by individual strategies this candle. */
    List<ActionEntry> actions;

    /** Signals blocked by trading rules this candle. */
    List<BlockedSignal> blockedSignals;

    /**
     * Actions taken by the Combined pool this candle (only when scoreConfig.enabled).
     * Includes score breakdown for each entry.
     */
    List<CombinedDetail> combinedDetails;

    // ─── Combined pool analytics (per candle) ─────────────────────────────────

    /** Label of the strategy with the highest score this candle; null when combined didn't score. */
    String combinedWinner;

    /** Total score of the winning strategy; null if no winner this candle. */
    Double combinedWinnerScore;

    /**
     * ALL strategies that produced a non-HOLD signal and were scored this candle,
     * sorted by score descending. Format: "LABEL SIGNAL score=XX.X".
     * Includes strategies below the score threshold (use combinedCandidates for above-threshold only).
     */
    List<String> combinedAllScored;

    /**
     * Strategies that passed the score threshold this candle (subset of combinedAllScored).
     * Format: "label:signal(score)". Empty when combined is blocked or scoreConfig is off.
     */
    List<String> combinedCandidates;

    /** Reason the combined pool was blocked from acting this candle; null if not blocked. */
    String combinedBlockReason;

    // ─── Market context ───────────────────────────────────────────────────────

    /** Cumulative intraday VWAP up to this candle; null when volume is zero. */
    Double vwap;

    /** Distance of close from VWAP as a percentage: (close − vwap) / vwap × 100. */
    Double distanceFromVwapPct;

    /** Per-label snapshot of capital, open position, closed trades, equity history. */
    Map<String, StrategyState> strategyStates;

    // ─── Progress ─────────────────────────────────────────────────────────────

    /** Number of candles emitted so far (1-based). */
    int emitted;

    /** Total number of candles to stream. */
    int total;

    // ─── Nested types ─────────────────────────────────────────────────────────

    @Value
    @Builder
    public static class ActionEntry {
        /** Strategy label (or COMBINED_LABEL for combined pool). */
        String strategyLabel;
        /** "Enter Long" / "Exit Long" / "Enter Short" / "Exit Short". */
        String action;
        /** Human-readable reason (e.g. "Signal", "Stop Loss hit", "Take Profit hit"). */
        String reason;
        /** Exit reason code (SIGNAL / STOP_LOSS / TAKE_PROFIT / END_OF_BACKTEST). */
        String exitReason;
        double price;
        /** Regime at time of action; null if regime off. */
        String regime;
    }

    @Value
    @Builder
    public static class BlockedSignal {
        String strategy;
        /** "BUY" or "SELL" */
        String signal;
        /** Human-readable reason the signal was blocked. */
        String reason;
        double price;
    }

    @Value
    @Builder
    public static class CombinedDetail {
        /** "Enter Long" / "Exit Long" / "Enter Short" / "Exit Short". */
        String action;
        /** Human-readable reason. */
        String reason;
        /** Strategy that provided the winning signal. */
        String sourceStrategy;
        /** Formatted score breakdown string. */
        String trigger;
        /** Exit reason code (non-null on exits). */
        String exitReason;
        double price;
        String regime;
        /** Full score breakdown for this action (non-null on entries). */
        ScoreDetail score;
    }

    @Value
    @Builder
    public static class StrategyState {
        double capital;
        OpenPosition openPosition;
        List<ClosedTrade> closedTrades;
        List<EquityPoint> equityHistory;
    }

    @Value
    @Builder
    public static class OpenPosition {
        /** "LONG" or "SHORT". */
        String type;
        double entryPrice;
        int qty;
        String entryTime;
        Double slPrice;
        Double tpPrice;
        String regime;
        String sourceStrategy;
    }

    @Value
    @Builder
    public static class ClosedTrade {
        /** "LONG" or "SHORT". */
        String type;
        String entryTime;
        String exitTime;
        /** SIGNAL / STOP_LOSS / TAKE_PROFIT / END_OF_BACKTEST. */
        String exitReason;
        String regime;
        String sourceStrategy;
        double entryPrice;
        double exitPrice;
        double pnl;
        double pnlPct;
        double capitalAfter;
        int qty;
    }

    @Value
    @Builder
    public static class EquityPoint {
        String time;
        double capital;
    }

    @Value
    @Builder
    public static class ScoreDetail {
        double total;
        double baseScore;
        double trendStrength;
        double volatility;
        double momentum;
        double confidence;
        double totalPenalty;
    }

    // ─── Factory helper ───────────────────────────────────────────────────────

    /** Converts a StrategyScorer.ScoreResult into the lightweight ScoreDetail DTO. */
    public static ScoreDetail toScoreDetail(StrategyScorer.ScoreResult sr) {
        if (sr == null) return null;
        return ScoreDetail.builder()
                .total(sr.getTotal())
                .baseScore(sr.getBaseScore())
                .trendStrength(sr.getTrendStrength())
                .volatility(sr.getVolatilityScore())
                .momentum(sr.getMomentumScore())
                .confidence(sr.getConfidenceScore())
                .totalPenalty(sr.getTotalPenalty())
                .build();
    }
}
