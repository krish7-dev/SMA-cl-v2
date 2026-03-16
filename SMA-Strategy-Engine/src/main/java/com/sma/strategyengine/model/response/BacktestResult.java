package com.sma.strategyengine.model.response;

import lombok.Builder;
import lombok.Value;

import com.sma.strategyengine.service.StrategyScorer;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * Complete result of a backtest run containing metrics for each
 * strategy configuration that was evaluated.
 */
@Value
@Builder
public class BacktestResult {

    String        symbol;
    String        exchange;
    String        interval;
    LocalDateTime fromDate;
    LocalDateTime toDate;
    int           totalCandles;
    int           resolvedQuantity;   // actual qty used (auto-computed if request was 0)

    /** Label of the strategy with the highest total PnL. */
    String bestStrategyLabel;

    List<StrategyRunResult> results;

    // ─── Per-strategy result ──────────────────────────────────────────────────

    @Value
    @Builder
    public static class StrategyRunResult {
        String              strategyType;
        String              label;
        Map<String, String> parameters;
        Metrics             metrics;
        List<TradeEntry>    trades;
    }

    // ─── Metrics ──────────────────────────────────────────────────────────────

    @Value
    @Builder
    public static class Metrics {
        int        totalTrades;
        int        winningTrades;
        int        losingTrades;
        double     winRate;           // 0–100 %
        BigDecimal totalPnl;
        BigDecimal initialCapital;
        BigDecimal finalCapital;
        double     totalReturnPct;
        double     maxDrawdownPct;
        double     profitFactor;      // grossProfit / grossLoss; 0 if no losses
        BigDecimal avgWin;
        BigDecimal avgLoss;
        BigDecimal bestTrade;
        BigDecimal worstTrade;
        double     sharpeRatio;       // simplified trade-level Sharpe
        int        warmupCandles;     // candles consumed before first signal possible
        // Risk management exit counters (0 when risk is OFF)
        int        stopLossExits;
        int        takeProfitExits;
        int        dailyCapHalts;     // entry attempts blocked by daily loss cap
    }

    // ─── Individual trade ─────────────────────────────────────────────────────

    @Value
    @Builder
    public static class TradeEntry {
        LocalDateTime entryTime;
        LocalDateTime exitTime;
        BigDecimal    entryPrice;
        BigDecimal    exitPrice;
        int           quantity;
        BigDecimal    pnl;
        double        pnlPct;
        BigDecimal    runningCapital;   // capital after this trade closes
        String        exitReason;       // SIGNAL | STOP_LOSS | TAKE_PROFIT | END_OF_BACKTEST | REGIME_CHANGE
        String        direction;        // LONG | SHORT
        List<String>  entryPatterns;    // candlestick patterns detected on the entry candle (may be empty)
        String        regime;           // TRENDING | RANGING | VOLATILE | COMPRESSION — null when regime detection off
        // Score-switched combined pool fields (null for non-combined runs)
        String                        selectedStrategy; // strategy type chosen by scorer (null for single-strategy runs)
        StrategyScorer.ScoreResult    scoreBreakdown;  // full score breakdown when score-switching was active
    }
}
