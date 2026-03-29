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
        private int switchConfirmationCandles = 2;
        private int maxSwitchesPerDay         = 3;
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
        private double  minRangeWidthPct             = 0.4;
        private double  maxRangeWidthPct             = 2.0;
        private double  maxDirectionalDriftPctOfRange = 0.6;
        private double  chopFlipRatioLimit           = 0.65;
        private boolean enableChopCheck              = true;
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

    private int     speedMultiplier = 1;
    private boolean persist         = true;
}
