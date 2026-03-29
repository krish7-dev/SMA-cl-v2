package com.sma.strategyengine.service.options;

import lombok.Builder;
import lombok.Data;
import java.util.List;

@Data
@Builder
public class NiftyDecisionResult {

    public enum Bias { BULLISH, BEARISH, NEUTRAL }

    private Bias   rawBias;
    private Bias   confirmedBias;
    private Bias   previousBias;

    private String winnerStrategy;
    private double winnerScore;
    private double scoreGap;
    private String confidenceLevel;   // HIGH / MEDIUM / LOW / NONE
    private String regime;

    private double recentMove3;
    private double recentMove5;
    private double distanceFromVwap;
    private double vwap;

    private boolean entryAllowed;
    private String  blockReason;

    /** Explains exactly why rawBias is NEUTRAL — more specific than blockReason. */
    private String  neutralReason;   // NO_SIGNALS | ALL_SIGNALS_BELOW_SCORE | SCORE_GAP_TOO_SMALL

    /** Effective thresholds used this candle (may differ from base config when RegimeRules active). */
    private double  effectiveMinScore;
    private double  effectiveMinScoreGap;

    // ── Top-2 explicit comparison ──────────────────────────────────────────────
    private String  secondStrategy;
    private double  secondScore;

    // ── Shadow winner (best candidate regardless of eligibility thresholds) ────
    private String  shadowWinner;
    private double  shadowWinnerScore;
    private String  shadowWinnerReasonNotTaken;  // why it wasn't promoted to winner

    private boolean switchRequested;
    private boolean switchConfirmed;
    private String  switchReason;
    private int     switchCountToday;

    /** All strategies evaluated this candle, including those that returned HOLD. */
    private List<CandidateScore> candidates;

    // ─────────────────────────────────────────────────────────────────────────

    @Data
    @Builder
    public static class CandidateScore {
        private String  strategyType;
        private String  signal;              // BUY | SELL | NONE (hold)

        // ── Score pipeline components ────────────────────────────────────────
        private double  baseScore;           // weighted sum before penalties
        private double  trendComponent;      // ADX-proxy component
        private double  volatilityComponent; // ATR% component
        private double  momentumComponent;   // ROC component
        private double  confidenceComponent; // regime-match component

        // ── Penalties ────────────────────────────────────────────────────────
        private double  penaltyReversal;
        private double  penaltyOverextension;
        private double  penaltySameColor;
        private double  penaltyMismatch;
        private double  penaltyVolatileOption;
        private double  totalPenalty;

        // ── Final ─────────────────────────────────────────────────────────────
        private double  score;               // final score = base - penalties
        private boolean eligible;            // score >= minScore
        private String  eligibilityReason;   // null if eligible, else explanation

        // ── Legacy aliases (kept for older consumers) ─────────────────────────
        private double  trendStrength;       // = trendComponent
        private double  volatility;          // = volatilityComponent
        private double  momentum;            // = momentumComponent
        private double  confidence;          // = confidenceComponent
        private double  penalty;             // = totalPenalty
    }
}
