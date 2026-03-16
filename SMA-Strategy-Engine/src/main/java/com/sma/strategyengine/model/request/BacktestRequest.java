package com.sma.strategyengine.model.request;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * Request to run one or more strategies against historical candle data.
 *
 * Multiple strategy configurations can be compared in a single call — the
 * response contains metrics for each so performance can be compared side by side.
 */
@Data
public class BacktestRequest {

    @NotBlank(message = "userId is required")
    private String userId;

    @NotBlank(message = "brokerName is required")
    private String brokerName;

    @NotBlank(message = "symbol is required")
    private String symbol;

    @NotBlank(message = "exchange is required")
    private String exchange;

    /**
     * Numeric Kite instrument token (e.g. 738561 for RELIANCE NSE).
     * Required so Data Engine can call the broker historical data API.
     */
    @NotNull(message = "instrumentToken is required")
    private Long instrumentToken;

    /**
     * Candle interval as enum NAME: MINUTE_1, MINUTE_3, MINUTE_5, MINUTE_10,
     * MINUTE_15, MINUTE_30, MINUTE_60, DAY, WEEK, MONTH.
     */
    @NotBlank(message = "interval is required")
    private String interval;

    /** Range start in exchange local time (IST). */
    @NotNull(message = "fromDate is required")
    private LocalDateTime fromDate;

    /** Range end in exchange local time (IST). */
    @NotNull(message = "toDate is required")
    private LocalDateTime toDate;

    /** Product type forwarded to order intent: MIS / CNC / NRML. */
    private String product = "MIS";

    /**
     * Allow shorting. When true, SELL signals open short positions; BUY signals cover them.
     * Reversals (LONG→SHORT and SHORT→LONG) are simulated via a single close+reopen on the same candle close.
     * Requires product = MIS or NRML; CNC does not support shorting in live markets.
     * Defaults to false (long-only, original behaviour).
     */
    private boolean allowShorting = false;

    /**
     * Number of units per trade signal.
     * 0 = auto-compute: floor(initialCapital / firstCandleClose) — max units the capital can buy.
     */
    @Min(value = 0, message = "quantity must be 0 (auto) or a positive integer")
    private int quantity = 0;

    /** Starting capital for PnL and drawdown calculations. */
    @NotNull
    @DecimalMin(value = "1", message = "initialCapital must be positive")
    private BigDecimal initialCapital = BigDecimal.valueOf(100_000);

    /** One or more strategy configurations to compare. */
    @NotEmpty(message = "at least one strategy configuration is required")
    @Valid
    private List<StrategyConfig> strategies;

    /**
     * Optional risk management overlay applied during simulation.
     * Null or enabled=false → vanilla signal-only backtest (original behaviour).
     */
    @Valid
    private RiskConfig riskConfig;

    /**
     * Optional candle pattern confirmation filter.
     * Null or enabled=false → all strategy signals fire without pattern check.
     */
    @Valid
    private PatternConfig patternConfig;

    /**
     * Optional market regime detection configuration.
     * Null or enabled=false → no regime filtering.
     */
    @Valid
    private RegimeConfig regimeConfig;

    /**
     * Optional score-based combined pool configuration.
     * When enabled, a "Score-Switched" combined result is prepended using all strategy
     * configs (regardless of activeRegimes). The scorer picks the highest-scoring
     * strategy per candle from a single shared capital pool.
     * Null or enabled=false → no score-based combined result.
     */
    @Valid
    private ScoreConfig scoreConfig;

    /**
     * Instrument type — used by the scorer for quality penalties.
     * "STOCK" (default) or "OPTION".
     */
    private String instrumentType = "STOCK";

    // ─── Nested types ─────────────────────────────────────────────────────────

    @Data
    public static class StrategyConfig {

        @NotBlank(message = "strategyType is required")
        private String strategyType;

        /** Optional human-readable label shown in results. Auto-generated if blank. */
        private String label;

        /** Strategy-specific parameters (e.g. {"shortPeriod":"5","longPeriod":"20"}). */
        private Map<String, String> parameters;

        /**
         * Regimes in which this strategy is allowed to open new positions.
         * Empty = active in all regimes (default behaviour).
         * Valid values: TRENDING, RANGING, VOLATILE, COMPRESSION
         */
        private List<String> activeRegimes = new java.util.ArrayList<>();
    }

    @Data
    public static class RiskConfig {

        /** Master switch — false (default) keeps all rules disabled. */
        private boolean enabled = false;

        /** Exit long when candle LOW drops this % below entry price. 0/null = SL off. */
        @DecimalMin(value = "0") @DecimalMax(value = "100")
        private BigDecimal stopLossPct;

        /** Exit long when candle HIGH rises this % above entry price. 0/null = TP off. */
        @DecimalMin(value = "0")
        private BigDecimal takeProfitPct;

        /**
         * Risk at most this % of running capital per trade.
         * Drives position sizing: qty = floor(capital × riskPct / (entry × slPct)).
         * Requires stopLossPct > 0; otherwise resolvedQty is used unchanged.
         */
        @DecimalMin(value = "0") @DecimalMax(value = "100")
        private BigDecimal maxRiskPerTradePct;

        /**
         * Halt new entries for the rest of a calendar day once cumulative daily
         * loss reaches this % of the day's starting capital. 0/null = cap off.
         */
        @DecimalMin(value = "0") @DecimalMax(value = "100")
        private BigDecimal dailyLossCapPct;

        /** Candles to skip after a losing trade before re-entering. 0 = no cooldown. */
        @Min(value = 0)
        private int cooldownCandles = 0;
    }

    @Data
    public static class RegimeConfig {

        /** Master switch. */
        private boolean enabled = false;

        /** ADX calculation period (default 14). */
        @Min(2) private int adxPeriod = 14;

        /** ATR calculation period (default 14). */
        @Min(2) private int atrPeriod = 14;

        /** ADX value above which market is classified TRENDING (default 25). */
        @DecimalMin("1") private double adxTrendThreshold = 25.0;

        /**
         * ATR as % of close price above which market is classified VOLATILE (default 2.0%).
         * E.g. 2.0 means ATR > 2% of current price.
         */
        @DecimalMin("0") private double atrVolatilePct = 2.0;

        /**
         * ATR as % of close price below which market is classified COMPRESSION (default 0.5%).
         * E.g. 0.5 means ATR < 0.5% of current price.
         */
        @DecimalMin("0") private double atrCompressionPct = 0.5;
    }

    @Data
    public static class ScoreConfig {

        /** Master switch. */
        private boolean enabled = false;

        /**
         * Minimum score threshold for entry (0–100). Signals with total score below
         * this value are skipped. Default 30 — low enough not to miss strong signals.
         */
        @DecimalMin("0") @DecimalMax("100")
        private double minScoreThreshold = 30.0;
    }

    @Data
    public static class PatternConfig {

        /** Master switch — false (default) keeps pattern filtering disabled. */
        private boolean enabled = false;

        /**
         * Wick-to-body ratio threshold for hammer / shooting-star detection.
         * The wick must be at least this multiple of the body size.
         */
        @DecimalMin(value = "0")
        private double minWickRatio = 2.0;

        /**
         * Maximum body / range ratio for hammer, shooting-star, and star-body detection.
         * E.g. 0.35 means body must be ≤ 35 % of the candle's high–low range.
         */
        @DecimalMin(value = "0") @DecimalMax(value = "1")
        private double maxBodyPct = 0.35;

        /**
         * BUY signal is only acted on when at least one of these patterns is also
         * detected on the same candle.  Empty list = no pattern filter for entries.
         * Valid names: HAMMER, BULLISH_ENGULFING, MORNING_STAR, DOJI_BULLISH
         */
        private List<String> buyConfirmPatterns = new java.util.ArrayList<>();

        /**
         * SELL signal is only acted on when at least one of these patterns is also
         * detected on the same candle.  Empty list = no pattern filter for exits.
         * Valid names: SHOOTING_STAR, BEARISH_ENGULFING, EVENING_STAR, DOJI_BEARISH
         */
        private List<String> sellConfirmPatterns = new java.util.ArrayList<>();
    }
}
