package com.sma.strategyengine.model.response;

import lombok.Builder;
import lombok.Data;
import java.util.List;

@Data
@Builder
public class OptionsReplayCandleEvent {

    // Progress
    private int emitted;
    private int total;

    // NIFTY candle
    private String niftyTime;
    private double niftyOpen, niftyHigh, niftyLow, niftyClose;
    private long   niftyVolume;

    // ── NIFTY decision fields ──────────────────────────────────────────────────
    private String  niftyBias;           // BULLISH / BEARISH / NEUTRAL
    private String  previousNiftyBias;
    private String  confirmedBias;
    private String  winnerStrategy;
    private double  winnerScore;
    private double  scoreGap;
    private String  confidenceLevel;     // HIGH / MEDIUM / LOW / NONE
    private String  regime;
    private double  recentMove3;
    private double  recentMove5;
    private double  distanceFromVwap;
    private int     barsSinceLastTrade;
    private boolean entryAllowed;
    private String  blockReason;
    /** Execution-layer wait reason (e.g. no option data, no premium, cooldown). Separate from decision blockReason. */
    private String  execWaitReason;

    /** Market phase: PRE_MARKET | TRADING | CLOSING | CLOSED */
    private String  marketPhase;
    /** false in PRE_MARKET and CLOSING phases — no new entries allowed */
    private boolean tradable;
    private double  penalizedScore;

    /** Trade quality tier: STRONG / NORMAL / WEAK / NONE */
    private String  tradeStrength;

    /** Why rawBias is NEUTRAL: NO_SIGNALS | ALL_SIGNALS_BELOW_SCORE | SCORE_GAP_TOO_SMALL */
    private String  neutralReason;

    /** Effective thresholds used this candle (may differ from base config when RegimeRules active). */
    private double  effectiveMinScore;
    private double  effectiveMinScoreGap;

    // Top-2 explicit comparison
    private String  secondStrategy;
    private double  secondScore;

    // Shadow winner (best candidate regardless of eligibility thresholds)
    private String  shadowWinner;
    private double  shadowWinnerScore;
    private String  shadowWinnerReasonNotTaken;

    private boolean switchRequested;
    private boolean switchConfirmed;
    private String  switchReason;
    private int     switchCountToday;
    private int     confirmCount;
    private int     confirmRequired;

    /** All strategies evaluated (including HOLD) with full score pipeline breakdown. */
    private List<CandidateScore> candidates;

    // ── Execution fields ───────────────────────────────────────────────────────
    private String positionState;        // FLAT / LONG_CALL / LONG_PUT
    private String desiredSide;          // NONE / CE / PE
    private String action;               // ENTERED / EXITED / HELD / FORCE_CLOSED / WAITING
    private String exitReason;

    // Hold debug fields
    private String  entryRegime;         // regime at time of entry
    private int     appliedMinHold;      // minHold bars used this candle
    private boolean holdActive;          // true if inside the hold window

    // Exit evaluator debug fields
    private double  peakPnlPct;          // highest pnl% seen since entry
    private double  profitLockFloor;     // current profit lock floor %
    private boolean inHoldZone;          // true = pnl < holdZonePct; only SL can exit
    private boolean inStrongTrendMode;   // true = TRENDING + peak > strongModeThreshold

    // Selected option
    private String selectedOptionType;
    private double selectedStrike;
    private String selectedExpiry;
    private String selectedTradingSymbol;
    private Long   selectedToken;

    private double entryPrice;
    private Double exitPrice;
    private int    barsInTrade;
    private double unrealizedPnl;
    private double realizedPnl;
    private double totalPnl;
    private double capital;

    // Option candle for active instrument
    private String optionTime;
    private Double optionOpen, optionHigh, optionLow, optionClose;
    private Long   optionVolume;

    // Closed trades this session
    private List<ClosedTrade> closedTrades;

    // ─────────────────────────────────────────────────────────────────────────

    @Data
    @Builder
    public static class CandidateScore {
        private String  strategyType;
        private String  signal;              // BUY | SELL | NONE (hold)

        // ── Score pipeline components ────────────────────────────────────────
        private double  baseScore;
        private double  trendComponent;
        private double  volatilityComponent;
        private double  momentumComponent;
        private double  confidenceComponent;

        // ── Penalties ────────────────────────────────────────────────────────
        private double  penaltyReversal;
        private double  penaltyOverextension;
        private double  penaltySameColor;
        private double  penaltyMismatch;
        private double  penaltyVolatileOption;
        private double  totalPenalty;

        // ── Final ─────────────────────────────────────────────────────────────
        private double  score;
        private boolean eligible;
        private String  eligibilityReason;

        // ── Legacy aliases ────────────────────────────────────────────────────
        private double  trendStrength;
        private double  volatility;
        private double  momentum;
        private double  confidence;
        private double  penalty;
    }

    @Data
    @Builder
    public static class ClosedTrade {
        private String entryTime;
        private String exitTime;
        private String optionType;
        private String tradingSymbol;
        private double strike;
        private String expiry;
        private double entryPrice;
        private double exitPrice;
        private int    quantity;
        private double pnl;
        private double pnlPct;
        private String exitReason;
        private int    barsInTrade;
        private double capitalAfter;
        private String entryRegime;
    }
}
