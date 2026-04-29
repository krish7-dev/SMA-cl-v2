package com.sma.strategyengine.model.request;

import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Request for the Tick Replay Test — replays a stored live tick session
 * through the same NiftyDecisionEngine + OptionExecutionEngine pipeline
 * used by the live options service, without needing a broker API connection.
 *
 * Mirrors OptionsLiveRequest but uses sessionId in place of auth credentials.
 * All nested config classes are shared with OptionsReplayRequest.
 */
@Data
public class TickOptionsReplayRequest {

    // ── Session ───────────────────────────────────────────────────────────────
    private String        sessionId;           // Which live tick session to replay
    private String        interval = "MINUTE_5"; // Candle bucket interval — match the live session
    private LocalDateTime fromDate;            // Optional: replay only ticks at/after this time
    private LocalDateTime toDate;              // Optional: replay only ticks at/before this time

    /**
     * When false (default) the replay runs in "fast preview" mode:
     * no candle events are written to session_feed_chunk and autoSave is skipped.
     * Set to true only when the session should be persisted for Save-to-Compare.
     */
    private boolean saveForCompare = false;

    // ── Auth (for warmup candle fetch — auto-resolved from Broker Engine if omitted) ──
    private String userId;
    private String brokerName;

    // ── Warmup ────────────────────────────────────────────────────────────────
    /** Days of historical NIFTY candles to prime indicators and regime before the session starts. 0 = disabled. */
    private int warmupDays = 5;

    // ── NIFTY (decision source) ───────────────────────────────────────────────
    private Long   niftyInstrumentToken;
    private String niftySymbol   = "NIFTY 50";
    private String niftyExchange = "NSE";

    // ── Option pools ──────────────────────────────────────────────────────────
    private List<OptionsReplayRequest.OptionCandidate> ceOptions;
    private List<OptionsReplayRequest.OptionCandidate> peOptions;

    // ── Trade settings ────────────────────────────────────────────────────────
    private int    quantity        = 25;
    private double initialCapital  = 100000.0;
    private double speedMultiplier = 0;   // 0 = max speed (no delay between ticks)

    // ── Strategy + configs (all shared with OptionsReplayRequest) ─────────────
    private List<BacktestRequest.StrategyConfig>          strategies;
    private BacktestRequest.RegimeConfig                  regimeConfig;
    private OptionsReplayRequest.DecisionConfig           decisionConfig;
    private OptionsReplayRequest.SelectionConfig          selectionConfig;
    private OptionsReplayRequest.SwitchConfig             switchConfig;
    private OptionsReplayRequest.RegimeRules              regimeRules;
    private OptionsReplayRequest.RegimeStrategyRules      regimeStrategyRules;
    private OptionsReplayRequest.ChopRules                chopRules;
    private OptionsReplayRequest.RangeQualityConfig       rangeQualityConfig;
    private OptionsReplayRequest.TradeQualityConfig       tradeQualityConfig;
    private OptionsReplayRequest.TrendEntryConfig         trendEntryConfig;
    private OptionsReplayRequest.CompressionEntryConfig   compressionEntryConfig;
    private OptionsReplayRequest.PenaltyConfig            penaltyConfig;
    private OptionsReplayRequest.HoldConfig               holdConfig;
    private OptionsReplayRequest.RiskConfig               riskConfig;
    private OptionsReplayRequest.ExitConfig               exitConfig;
    private OptionsReplayRequest.TradingRules             tradingRules;
    private OptionsReplayRequest.MinMovementFilterConfig                minMovementFilterConfig;
    private OptionsReplayRequest.DirectionalConsistencyFilterConfig     directionalConsistencyFilterConfig;
    private OptionsReplayRequest.CandleStrengthFilterConfig             candleStrengthFilterConfig;
    private OptionsReplayRequest.NoNewTradesAfterTimeConfig             noNewTradesAfterTimeConfig;
    private OptionsReplayRequest.StopLossCascadeProtectionConfig        stopLossCascadeProtectionConfig;
    private OptionsReplayRequest.TradingHoursConfig                     tradingHoursConfig;
}
