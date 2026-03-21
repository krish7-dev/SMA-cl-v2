package com.sma.strategyengine.model.request;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * Request to run a streaming replay evaluation in the Strategy Engine.
 *
 * The Strategy Engine fetches all historical candles (including warmup days),
 * runs full strategy evaluation, and streams enriched candle events back to the
 * client via SSE at a speed controlled by {@code speedMultiplier}.
 */
@Data
public class ReplayRequest {

    // ─── Identity ─────────────────────────────────────────────────────────────

    @NotBlank(message = "userId is required")
    private String userId;

    @NotBlank(message = "brokerName is required")
    private String brokerName;

    // ─── Instrument ───────────────────────────────────────────────────────────

    @NotBlank(message = "symbol is required")
    private String symbol;

    @NotBlank(message = "exchange is required")
    private String exchange;

    @NotNull(message = "instrumentToken is required")
    private Long instrumentToken;

    /**
     * "STOCK" (default) or "OPTION".
     * Used by the scorer for quality penalties and trading rules.
     */
    private String instrumentType = "STOCK";

    // ─── Candle parameters ────────────────────────────────────────────────────

    /**
     * Candle interval enum name: MINUTE_1, MINUTE_3, MINUTE_5, MINUTE_10,
     * MINUTE_15, MINUTE_30, MINUTE_60, DAY, WEEK, MONTH.
     */
    @NotBlank(message = "interval is required")
    private String interval;

    /** Replay start (IST). */
    @NotNull(message = "fromDate is required")
    private LocalDateTime fromDate;

    /** Replay end (IST). */
    @NotNull(message = "toDate is required")
    private LocalDateTime toDate;

    // ─── Preload / warmup ─────────────────────────────────────────────────────

    /**
     * Number of calendar days before {@code fromDate} to fetch for indicator warmup.
     * These candles are fed into evaluators silently (not streamed to the client).
     * Default 5.
     */
    @Min(0)
    private int preloadDaysBack = 5;

    /**
     * Candle interval for the warmup fetch.
     * Using a finer interval (e.g. MINUTE_5) loads more warmup data in a short period.
     * Defaults to the same as {@code interval}.
     */
    private String preloadInterval;

    // ─── Replay speed ─────────────────────────────────────────────────────────

    /**
     * Speed multiplier relative to real-time candle frequency.
     * 1.0 = real time, 2.0 = 2× faster, etc.
     * 0 or negative resets to 1.0.
     */
    @DecimalMin("0")
    private double speedMultiplier = 1.0;

    // ─── Combined pool mode ───────────────────────────────────────────────────

    /**
     * When true, individual strategies only compute signals for the ⚡ Combined pool
     * scoring — they do NOT open/close their own positions.
     * Requires scoreConfig.enabled = true to have any effect.
     */
    private boolean combinedOnlyMode = false;

    /**
     * When true, any open combined position remaining after the last replay candle
     * is force-closed at the last candle's close price so it appears in Trade History.
     */
    private boolean closeOpenPositionsAtEnd = false;

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
    private RulesConfig rulesConfig;

    @Valid
    private EntryFilterConfig entryFilterConfig;

    // ─── Nested types ─────────────────────────────────────────────────────────

    /**
     * Trading rules applied during replay evaluation.
     * Mirrors the frontend {@code EMPTY_RULES_CONFIG} object.
     */
    @Data
    public static class RulesConfig {

        /** Master switch — when false all rules are skipped. */
        private boolean enabled = true;

        /** Stock-specific rules. */
        private StockRules stocks = new StockRules();

        /** Options-specific rules. */
        private OptionRules options = new OptionRules();

        @Data
        public static class StockRules {

            /** Block all entries when regime is RANGING. */
            private boolean rangingNoTrade = true;

            /** Allow only SHORT entries when regime is COMPRESSION. */
            private boolean compressionShortOnly = true;

            /** Block same-candle reversals (e.g. close LONG then open SHORT on same candle). */
            private boolean noSameCandleReversal = true;

            /** Quality gate for LONG entries: requires min score + no reversal cooldown + within VWAP. */
            private LongQualityGate longQualityGate = new LongQualityGate();

            @Data
            public static class LongQualityGate {
                private boolean enabled = true;

                /**
                 * Minimum strategy score required to enter LONG.
                 * Signals below this threshold are blocked.
                 */
                @DecimalMin("0") @DecimalMax("100")
                private double scoreMin = 60.0;

                /**
                 * Maximum allowed distance from VWAP as a % of VWAP price.
                 * Entry is blocked when |close - vwap| / vwap * 100 > vwapMaxPct.
                 */
                @DecimalMin("0")
                private double vwapMaxPct = 1.5;
            }
        }

        @Data
        public static class OptionRules {

            /** Block all entries when regime is VOLATILE. */
            private boolean volatileNoTrade = true;

            /**
             * Skip signals from SMA_CROSSOVER and BREAKOUT strategies.
             * These slow/trend-following strategies are poorly suited for fast-moving options.
             */
            private boolean disableSmaBreakout = true;

            /** Block combined pool entry when the scorer's volatility component exceeds the threshold. */
            private boolean distrustHighVolScore = true;

            /**
             * Scorer volatility component ceiling.
             * Combined pool entries are blocked when scorer.volatilityScore > this value.
             */
            @DecimalMin("0") @DecimalMax("100")
            private double volScoreMax = 70.0;

            /** Block same-candle reversals. */
            private boolean noSameCandleReversal = true;
        }
    }

    /**
     * Post-signal entry filters applied after the combined pool picks a winner.
     * Each rule has independent stocks/options on/off switches.
     */
    @Data
    public static class EntryFilterConfig {

        /** Master switch — when false all filters are skipped. */
        private boolean enabled = false;

        @Data
        public static class RuleSwitch {
            private boolean stocks  = false;
            private boolean options = false;
        }

        // ── Score Gap ─────────────────────────────────────────────────────────
        private RuleSwitch scoreGap = new RuleSwitch();
        /** Skip entry if winner − second-best score < minGap. */
        @DecimalMin("0") private double minGap = 2.0;

        // ── Cooldown ──────────────────────────────────────────────────────────
        private RuleSwitch cooldown = new RuleSwitch();
        /** Skip entry if bars since last combined exit < minBars. */
        @Min(0) private int minBars = 3;

        // ── VWAP Extension ────────────────────────────────────────────────────
        private RuleSwitch vwapExtension = new RuleSwitch();
        /** Skip entry if |distanceFromVwap%| > maxDistPct. */
        @DecimalMin("0") private double maxDistPct = 1.5;

        // ── Strategy Filter ───────────────────────────────────────────────────
        private RuleSwitch strategyFilter = new RuleSwitch();
        /** Comma-separated strategy labels to block from triggering combined entries. */
        private String blocked = "SMA_CROSSOVER,EMA_CROSSOVER,MACD";

        // ── Confidence Gate ───────────────────────────────────────────────────
        private RuleSwitch confidenceGate = new RuleSwitch();
        /** Skip entry if scoreGap < minConfGap AND winner != exceptionStrategy. */
        @DecimalMin("0") private double minConfGap = 3.0;
        /** Strategy label exempt from confidence gate (e.g. LIQUIDITY_SWEEP). */
        private String exceptionStrategy = "LIQUIDITY_SWEEP";
    }
}
