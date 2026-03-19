package com.sma.strategyengine.model.request;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.Data;

import java.math.BigDecimal;
import java.util.List;

/**
 * Request to start a live (real-time) strategy evaluation session in the Strategy Engine.
 *
 * <p>The Strategy Engine subscribes to the Data Engine tick SSE stream, builds candles
 * from ticks per the specified {@code candleInterval}, runs the full evaluation pipeline
 * (regime, scoring, trading rules, position management), and streams enriched
 * {@link com.sma.strategyengine.model.response.ReplayCandleEvent} objects back via SSE.
 *
 * <p>Multiple instruments can be evaluated in a single session.
 */
@Data
public class LiveEvalRequest {

    // ─── Identity ─────────────────────────────────────────────────────────────

    @NotBlank(message = "userId is required")
    private String userId;

    @NotBlank(message = "brokerName is required")
    private String brokerName;

    // ─── Instruments ──────────────────────────────────────────────────────────

    /** Per-instrument configs; at least one required. */
    @NotEmpty(message = "at least one instrument is required")
    @Valid
    private List<InstrumentConfig> instruments;

    // ─── Candle interval ──────────────────────────────────────────────────────

    /**
     * Candle interval for building candles from ticks.
     * Enum name: MINUTE_1, MINUTE_3, MINUTE_5, MINUTE_10, MINUTE_15, MINUTE_30, MINUTE_60, DAY.
     */
    @NotBlank(message = "candleInterval is required")
    private String candleInterval;

    // ─── Preload / warmup ─────────────────────────────────────────────────────

    /**
     * Number of calendar days of historical data to fetch before live ticks start.
     * Used to warm up indicator/regime/scorer windows. Default 5.
     */
    @Min(0)
    private int preloadDaysBack = 5;

    /**
     * Candle interval for the warmup fetch.
     * Defaults to the same as {@code candleInterval} if blank.
     */
    private String preloadInterval;

    // ─── Capital ──────────────────────────────────────────────────────────────

    @NotNull
    @DecimalMin(value = "1", message = "initialCapital must be positive")
    private BigDecimal initialCapital = BigDecimal.valueOf(100_000);

    /**
     * Units per trade. 0 = auto: floor(initialCapital / firstCandleClose).
     */
    @Min(0)
    private int quantity = 0;

    /** Product type: MIS / CNC / NRML. */
    private String product = "MIS";

    // ─── Mode flags ───────────────────────────────────────────────────────────

    /**
     * When true, individual strategies only compute signals for the Combined pool
     * scoring — they do NOT open/close their own positions.
     * Requires scoreConfig.enabled = true.
     */
    private boolean combinedOnlyMode = false;

    /**
     * When true, the session will attempt to restore capital, positions, closed trades,
     * and candle log history from the last saved snapshot for this (userId, brokerName) pair.
     */
    private boolean resumeFromSnapshot = false;

    /**
     * Master shorting flag — overrides per-strategy allowShorting when false.
     */
    private boolean allowShorting = true;

    // ─── Strategies ───────────────────────────────────────────────────────────

    @NotEmpty(message = "at least one strategy configuration is required")
    @Valid
    private List<BacktestRequest.StrategyConfig> strategies;

    // ─── Optional overlays ────────────────────────────────────────────────────

    @Valid
    private BacktestRequest.RiskConfig riskConfig;

    @Valid
    private BacktestRequest.PatternConfig patternConfig;

    @Valid
    private BacktestRequest.RegimeConfig regimeConfig;

    @Valid
    private BacktestRequest.ScoreConfig scoreConfig;

    @Valid
    private ReplayRequest.RulesConfig rulesConfig;

    // ─── Nested types ─────────────────────────────────────────────────────────

    @Data
    public static class InstrumentConfig {

        @NotNull(message = "instrumentToken is required")
        private Long instrumentToken;

        @NotBlank(message = "symbol is required")
        private String symbol;

        @NotBlank(message = "exchange is required")
        private String exchange;

        /**
         * "STOCK" (default) or "OPTION".
         * Used by the scorer for quality penalties and trading rules.
         */
        private String instrumentType = "STOCK";
    }
}
