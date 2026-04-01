package com.sma.strategyengine.model.request;

import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Data
public class OptionsReplayRequest {

    private String userId;
    private String brokerName;
    private String apiKey;
    private String accessToken;

    // NIFTY (decision source only — never traded)
    private Long          niftyInstrumentToken;
    private String        niftySymbol   = "NIFTY 50";
    private String        niftyExchange = "NSE";
    private String        interval      = "MINUTE_5";
    private LocalDateTime fromDate;
    private LocalDateTime toDate;
    private int           warmupDays    = 5;

    // Option candidate pools
    private List<OptionCandidate> ceOptions;
    private List<OptionCandidate> peOptions;

    @Data
    public static class OptionCandidate {
        private Long   instrumentToken;
        private String tradingSymbol;
        private String exchange   = "NFO";
        private double strike;
        private String expiry;
        private String optionType; // CE / PE
    }

    // Trade settings
    private int        quantity       = 0;
    private BigDecimal initialCapital = BigDecimal.valueOf(100_000);

    // Strategies (evaluated on NIFTY only)
    private List<BacktestRequest.StrategyConfig> strategies;
    private BacktestRequest.RegimeConfig         regimeConfig;
    private BacktestRequest.ScoreConfig          scoreConfig;

    // Decision engine config
    private DecisionConfig decisionConfig = new DecisionConfig();

    @Data
    public static class DecisionConfig {
        private double  minScore          = 40.0;
        private double  minScoreGap       = 8.0;
        private double  maxRecentMove3    = 1.5;
        private double  maxRecentMove5    = 2.5;
        private double  maxAbsVwapDist    = 1.5;
        private int     minBarsSinceTrade = 3;
        private boolean chopFilter        = true;
        private int     chopLookback      = 8;
        /** Floor for winner score after entry penalties are applied. Trades below this are blocked. */
        private double  penaltyMinScore   = 25.0;
        /** If raw winnerScore >= this, penalties cannot push penalizedScore below scoreFloorMin. */
        private double  scoreFloorTrigger = 35.0;
        /** Minimum penalizedScore when scoreFloorTrigger is met. 0 = disabled. */
        private double  scoreFloorMin     = 25.0;
        /** BOLLINGER_REVERSION bonus: if winnerScore >= this, add bollingerBonus to penalizedScore. */
        private double  bollingerBonusThreshold = 35.0;
        /** Points added to penalizedScore when BOLLINGER bonus triggers. 0 = disabled. */
        private double  bollingerBonus    = 5.0;
        /** Allow early entry if winnerScore has risen for this many consecutive candles. 0 = disabled. */
        private int     earlyEntryRisingBars = 2;
        /** Raw score bypass: if winnerScore >= this AND scoreGap >= rawScoreBypassGap, allow entry regardless of penalized score. 0 = disabled. */
        private double  rawScoreBypassThreshold = 30.0;
        /** Min score gap required for raw score bypass. */
        private double  rawScoreBypassGap       = 3.0;
        /** BOLLINGER_REVERSION: if winnerScore >= this, override confirmRequired to 1 (early reversal). 0 = disabled. */
        private double  bollingerEarlyEntryMinScore = 28.0;
    }

    // Option selection
    private SelectionConfig selectionConfig = new SelectionConfig();

    @Data
    public static class SelectionConfig {
        private double minPremium = 50.0;
        private double maxPremium = 300.0;
    }

    // Switch confirmation
    private SwitchConfig switchConfig = new SwitchConfig();

    @Data
    public static class SwitchConfig {
        private int    switchConfirmationCandles   = 2;
        private int    maxSwitchesPerDay           = 3;
        /**
         * Require the new winner score to exceed the score that locked in the current
         * confirmed bias by at least this amount.  0 = disabled.
         */
        private double minScoreImprovementForSwitch = 0.0;
    }

    // Regime-aware score rules (override minScore / minScoreGap per regime)
    private RegimeRules regimeRules = new RegimeRules();

    @Data
    public static class RegimeRules {
        private boolean enabled               = true;
        // RANGING — still selective but slightly more permissive than volatile
        private double  rangingMinScore       = 35.0;
        private double  rangingMinScoreGap    = 6.0;
        // TRENDING — price has clear direction; fire on lower certainty
        private double  trendingMinScore      = 25.0;
        private double  trendingMinScoreGap   = 3.0;
        // COMPRESSION — breakout setup; treat same as trending
        private double  compressionMinScore   = 25.0;
        private double  compressionMinScoreGap = 3.0;
        // VOLATILE — fallback to base DecisionConfig values (no override)
    }

    // Per-regime chop filter overrides
    private ChopRules chopRules = new ChopRules();

    @Data
    public static class ChopRules {
        private boolean enabled = false;
        // Per-regime: null flipRatio = use global; filterEnabled=false = skip chop check entirely
        private RegimeChop ranging     = new RegimeChop();
        private RegimeChop trending    = new RegimeChop();
        private RegimeChop compression = new RegimeChop();
        private RegimeChop volatileRegime = new RegimeChop();

        @Data
        public static class RegimeChop {
            private boolean filterEnabled = true;   // false = disable chop filter for this regime
            private double  flipRatio     = 0.65;   // 0.65 normal · 0.80+ softer · 0.50 stricter
        }
    }

    // Trading rules — applied after decision engine, before execution
    private TradingRules tradingRules = new TradingRules();

    @Data
    public static class TradingRules {
        private boolean enabled               = false;
        private boolean rangingNoTrade        = false;
        private boolean volatileNoTrade       = false;
        private boolean noSameCandleReversal  = false;
    }

    // Per-regime strategy allow-lists (empty list = all strategies allowed)
    private RegimeStrategyRules regimeStrategyRules = new RegimeStrategyRules();

    @Data
    public static class RegimeStrategyRules {
        private boolean      enabled         = false;
        private List<String> ranging         = new ArrayList<>();
        private List<String> trending        = new ArrayList<>();
        private List<String> compression     = new ArrayList<>();
        private List<String> volatileRegime  = new ArrayList<>(); // 'volatile' is a Java keyword
    }

    // Range quality filter (RANGING regime only)
    private RangeQualityConfig rangeQualityConfig = new RangeQualityConfig();

    @Data
    public static class RangeQualityConfig {
        private boolean enabled                      = false;
        private int     lookbackBars                 = 10;
        private int     minUpperTouches              = 2;
        private int     minLowerTouches              = 2;
        private double  bandTouchTolerancePct        = 0.15;
        private double  minRangeWidthPct             = 0.3;
        private double  maxRangeWidthPct             = 3.0;
        private double  maxDirectionalDriftPctOfRange = 0.6;
        private double  chopFlipRatioLimit           = 0.65;
        private boolean enableChopCheck              = true;
    }

    // Minimum hold period after entry (prevents premature exits on transient neutral/no-signal)
    private HoldConfig holdConfig = new HoldConfig();

    @Data
    public static class HoldConfig {
        private boolean enabled             = true;
        /** Default minimum bars to hold before bias-based exit is allowed. */
        private int     defaultMinHoldBars  = 3;
        /** RANGING: signal is noisier — hold longer. */
        private int     rangingMinHoldBars  = 4;
        /** TRENDING: signal is cleaner — hold shorter. */
        private int     trendingMinHoldBars = 2;
        /** Score threshold for the opposite bias to force an early exit inside the hold window. */
        private double  strongOppositeScore = 35.0;
        /** After hold window: how many consecutive non-favourable bars needed to exit. */
        private int     persistentExitBars  = 2;
    }

    // Risk management
    private RiskConfig riskConfig = new RiskConfig();

    @Data
    public static class RiskConfig {
        private boolean enabled            = false;
        private double  stopLossPct        = 2.0;
        private double  takeProfitPct      = 4.0;
        private double  maxRiskPerTradePct = 1.0;
        private double  dailyLossCapPct    = 5.0;
        private int     cooldownCandles    = 3;
    }

    // Trade quality filter (score tiers, regime-based confirmation, weak trade rules)
    private TradeQualityConfig tradeQualityConfig = new TradeQualityConfig();

    // Trending entry structure validator
    private TrendEntryConfig trendEntryConfig = new TrendEntryConfig();

    @Data
    public static class TrendEntryConfig {
        private boolean enabled          = false;
        /** Candles to look back for breakout high/low (excluding current). */
        private int     breakoutLookback = 5;
        /** Minimum body % of full range to qualify as a "strong candle". */
        private double  minBodyPct       = 45.0;
        /** Body % below this → hard block (weak candle). */
        private double  weakBodyPct      = 20.0;
        /** EMA period used for momentum slope check. */
        private int     ema9Period       = 9;
    }

    // Compression entry structure validator (mean reversion at extremes)
    private CompressionEntryConfig compressionEntryConfig = new CompressionEntryConfig();

    @Data
    public static class CompressionEntryConfig {
        private boolean enabled              = false;
        /** Candles to look back for range definition (excluding current). */
        private int     rangeLookback        = 10;
        /** rangePos ≤ this for BULLISH entry (near bottom). */
        private double  longZoneMax          = 0.2;
        /** rangePos ≥ this for BEARISH entry (near top). */
        private double  shortZoneMin         = 0.8;
        /** Block entry if rangePos is in [noTradeZoneMin, noTradeZoneMax]. */
        private double  noTradeZoneMin       = 0.4;
        private double  noTradeZoneMax       = 0.6;
        /** Block if current candle breaks the defined range. */
        private boolean rejectBreakoutCandle = true;
    }

    @Data
    public static class TradeQualityConfig {
        private boolean enabled                = false;
        /** penalizedScore >= this → STRONG */
        private double  strongScoreThreshold   = 40.0;
        /** penalizedScore >= this (and < strong) → NORMAL */
        private double  normalScoreThreshold   = 32.0;
        /** Block WEAK trades for this many candles after a loss */
        private int     weakTradeLossCooldown  = 5;
        /** Block WEAK trades in RANGING regime */
        private boolean blockWeakInRanging     = true;
        /** Min penalizedScore for WEAK trades allowed in RANGING (when blockWeakInRanging=true). */
        private double  weakRangingMinScore    = 28.0;
        /** Min score gap for WEAK trades allowed in RANGING. */
        private double  weakRangingMinGap      = 3.0;
        /** Confirmation candles required in RANGING regime */
        private int     rangingConfirmCandles  = 2;
        /** Confirmation candles required in TRENDING/COMPRESSION regime */
        private int     trendingConfirmCandles = 1;
    }

    // Smart exit system
    private ExitConfig exitConfig = new ExitConfig();

    @Data
    public static class ExitConfig {
        private boolean enabled = true;

        // P1 — Hard Stop Loss (always fires, even inside hold zone)
        private double hardStopPct               = 7.0;

        // Hold Zone — profit must clear this before ANY non-SL exit is allowed
        // (except P6d dead-trade kill which fires from inside the hold zone)
        private double holdZonePct               = 5.0;

        // P2 — Profit Lock tiers (only arm once profit clears holdZonePct)
        private double lock1TriggerPct           = 5.0;   // +5%  → floor 2%
        private double lock1FloorPct             = 2.0;
        private double lock2TriggerPct           = 10.0;  // +10% → floor 5%
        private double lock2FloorPct             = 5.0;
        private double trailTriggerPct           = 15.0;  // +15% → trail 40% of peak
        private double trailFactor               = 0.40;

        // P3 — First-move protection (disabled by default; hold zone supersedes it)
        private int    firstMoveBars             = 0;
        private double firstMoveLockPct          = 0.5;

        // P4 — Structure failure (skipped in RANGING)
        private int    structureLookback         = 5;

        // P5a — Score Collapsed: DISABLED (score must NOT trigger exit)
        private double scoreDropFactor           = 0.0;

        // P5b — Score Below Floor: DISABLED (score must NOT trigger exit)
        private double scoreAbsoluteMin          = 0.0;

        // P5c — Bias exit
        private boolean biasExitEnabled          = true;
        /**
         * Minimum score for opposite bias to exit.
         * TRENDING uses this in both normal and Strong Trend Mode.
         * Non-TRENDING exits on any confirmed flip.
         */
        private double strongExitScore           = 40.0;

        // Strong Trend Mode: TRENDING + peakPnl > this → only P1/P2/P5c(strong) allowed
        private double trendStrongModeThresholdPct = 5.0;

        // P6a/P6b — Time exit (non-TRENDING only)
        private int    maxBarsNoImprovement      = 3;
        private int    stagnationBars            = 2;

        // P6c — RANGING time limit
        private int    maxBarsRanging            = 6;

        // P6d — Dead Trade kill (any regime; also fires from inside hold zone)
        private int    maxBarsDeadTrade          = 10;
        private double deadTradePnlPct           = 2.0;

        // P7 — No-hope (non-TRENDING only)
        private double noHopeThresholdPct        = 1.5;
        private int    noHopeBars                = 2;
    }

    private int     speedMultiplier = 1;
    private boolean persist         = true;
}
