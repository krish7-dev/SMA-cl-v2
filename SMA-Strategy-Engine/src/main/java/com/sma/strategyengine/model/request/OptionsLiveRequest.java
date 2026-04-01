package com.sma.strategyengine.model.request;

import lombok.Data;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * Request payload for live (real-time) NIFTY-driven options evaluation.
 *
 * Same as {@link OptionsReplayRequest} except:
 *   - No fromDate / toDate (live uses current market time)
 *   - No speedMultiplier (live runs at real market speed)
 *   - No persist flag (live data is not persisted by the strategy engine)
 *
 * All nested config types are reused from {@link OptionsReplayRequest} to keep
 * the decision / execution pipeline identical to replay.
 */
@Data
public class OptionsLiveRequest {

    private String userId;
    private String brokerName;
    private String apiKey;
    private String accessToken;

    // NIFTY (decision source only — never traded)
    private Long   niftyInstrumentToken;
    private String niftySymbol   = "NIFTY 50";
    private String niftyExchange = "NSE";
    private String interval      = "MINUTE_5";
    private int    warmupDays    = 5;

    // Option candidate pools
    private List<OptionsReplayRequest.OptionCandidate> ceOptions;
    private List<OptionsReplayRequest.OptionCandidate> peOptions;

    // Trade settings
    private int        quantity       = 0;
    private BigDecimal initialCapital = BigDecimal.valueOf(100_000);

    // Strategies (evaluated on NIFTY only)
    private List<BacktestRequest.StrategyConfig> strategies;
    private BacktestRequest.RegimeConfig         regimeConfig;

    // Decision engine config
    private OptionsReplayRequest.DecisionConfig decisionConfig = new OptionsReplayRequest.DecisionConfig();

    // Option selection
    private OptionsReplayRequest.SelectionConfig selectionConfig = new OptionsReplayRequest.SelectionConfig();

    // Switch confirmation
    private OptionsReplayRequest.SwitchConfig switchConfig = new OptionsReplayRequest.SwitchConfig();

    // Regime-aware score rules
    private OptionsReplayRequest.RegimeRules regimeRules = new OptionsReplayRequest.RegimeRules();

    // Per-regime chop filter overrides
    private OptionsReplayRequest.ChopRules chopRules = new OptionsReplayRequest.ChopRules();

    // Trading rules
    private OptionsReplayRequest.TradingRules tradingRules = new OptionsReplayRequest.TradingRules();

    // Per-regime strategy allow-lists
    private OptionsReplayRequest.RegimeStrategyRules regimeStrategyRules = new OptionsReplayRequest.RegimeStrategyRules();

    // Range quality filter
    private OptionsReplayRequest.RangeQualityConfig rangeQualityConfig = new OptionsReplayRequest.RangeQualityConfig();

    // Minimum hold period
    private OptionsReplayRequest.HoldConfig holdConfig = new OptionsReplayRequest.HoldConfig();

    // Risk management
    private OptionsReplayRequest.RiskConfig riskConfig = new OptionsReplayRequest.RiskConfig();

    // Trade quality filter
    private OptionsReplayRequest.TradeQualityConfig tradeQualityConfig = new OptionsReplayRequest.TradeQualityConfig();

    // Trending entry structure validator
    private OptionsReplayRequest.TrendEntryConfig trendEntryConfig = new OptionsReplayRequest.TrendEntryConfig();

    // Compression entry structure validator
    private OptionsReplayRequest.CompressionEntryConfig compressionEntryConfig = new OptionsReplayRequest.CompressionEntryConfig();

    // Smart exit system
    private OptionsReplayRequest.ExitConfig exitConfig = new OptionsReplayRequest.ExitConfig();
}
