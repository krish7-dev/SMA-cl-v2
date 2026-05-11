package com.sma.aiengine.service;

import com.sma.aiengine.model.enums.*;
import com.sma.aiengine.model.request.CompletedTradeRequest;
import com.sma.aiengine.model.request.MarketContextRequest;
import com.sma.aiengine.model.request.TradeCandidateRequest;
import com.sma.aiengine.model.response.MarketContextResponse;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

@Component
class FallbackEvaluator {

    /**
     * Deterministic advisory when OpenAI is disabled or unavailable.
     * Accumulates risk signals from all available fields; action determined by
     * combined signal weight, not a single first-match rule.
     */
    AdvisoryAiOutput advisory(TradeCandidateRequest req) {
        String regime = req.getRegime();

        // ── 1. Compression → AVOID immediately ───────────────────────────────
        if ("COMPRESSION".equalsIgnoreCase(regime)) {
            return new AdvisoryAiOutput(
                    AdvisoryAction.AVOID, 0.80, 0.20, RiskLevel.HIGH,
                    0.0, 0.90, 0.0, 0.0,
                    List.of("COMPRESSION_REGIME"), List.of(),
                    "Compression regime detected — high chop risk, avoid entry."
            );
        }

        // ── 2. Collect risk signals ───────────────────────────────────────────
        double reversalRisk      = 0.0;
        double overextensionRisk = 0.0;
        double lateEntryRisk     = 0.0;

        List<String> reasonCodes  = new ArrayList<>();
        List<String> warningCodes = new ArrayList<>();
        List<String> summaryParts = new ArrayList<>();
        boolean forceCaution = false;

        String  alignment        = req.getRecentMomentumAlignment();
        Integer opposeCount      = req.getRecentCandlesOpposeTradeCount();
        Integer supportCount     = req.getRecentCandlesSupportTradeCount();
        boolean isOppositeWinner = Boolean.TRUE.equals(req.getIsOppositeSideAfterStrongWinner());
        Double  winningScore     = req.getWinningScore();
        Double  scoreGap         = req.getScoreGap();
        Double  move3            = req.getRecentMove3CandlePct();
        String  optType          = req.getCurrentOptionType();

        boolean momentumOpposes  = "OPPOSES_TRADE".equals(alignment);
        boolean momentumSupports = "SUPPORTS_TRADE".equals(alignment);
        boolean strongScore      = winningScore != null && scoreGap != null
                && winningScore >= 30.0 && scoreGap >= 8.0;
        boolean weakScore        = winningScore == null || scoreGap == null
                || winningScore < 20.0 || scoreGap < 5.0;
        int opp  = opposeCount  != null ? opposeCount  : 0;
        int supp = supportCount != null ? supportCount : 0;

        // ── Signal: momentum alignment ────────────────────────────────────────
        if (momentumOpposes) {
            reversalRisk += 0.45;
            reasonCodes.add("MOMENTUM_OPPOSES_TRADE");
            summaryParts.add("momentum opposes " + tradeLabel(optType) + " entry");
            forceCaution = true;
        } else if ("MIXED".equals(alignment)) {
            lateEntryRisk += 0.15;
        }

        // ── Signal: candle opposition count ───────────────────────────────────
        if (opp >= 4 && supp <= 1) {
            reversalRisk += 0.20;
            warningCodes.add("CANDLES_STRONGLY_OPPOSE");
            summaryParts.add("recent candles strongly oppose trade (" + opp + "/5 opposing)");
            forceCaution = true;
            // All candles oppose + alignment confirms = maximum contradiction signal
            if (opp >= 5 && momentumOpposes) {
                reversalRisk = Math.max(reversalRisk, 0.85);
            }
        } else if (opp >= 3) {
            reversalRisk += 0.10;
        }

        // ── Signal: opposite side after strong winner ─────────────────────────
        if (isOppositeWinner) {
            reversalRisk = Math.max(reversalRisk, 0.70);
            warningCodes.add("REVERSAL_TRAP_RISK");
            summaryParts.add("counter-trend reversal attempt after strong winner");
            // Allow through only when candles clearly confirm AND score is very strong
            boolean candleConfirm = momentumSupports && supp >= 3;
            boolean veryStrong    = winningScore != null && scoreGap != null
                    && winningScore >= 60.0 && scoreGap >= 30.0;
            if (!candleConfirm || !veryStrong) {
                forceCaution = true;
            }
        }

        // ── Signal: overextended recent move ──────────────────────────────────
        if (move3 != null && move3 >= 1.5) {
            overextensionRisk = Math.max(overextensionRisk, 0.60);
            if (!momentumOpposes) {
                // SUPPORTS_TRADE or unknown: entered late in same-direction move
                reasonCodes.add("OVEREXTENDED_MOVE");
                summaryParts.add("recent 3-candle move " + move3 + "% — overextension risk");
            } else {
                // OPPOSES_TRADE: large counter-trend surge before entry = higher reversal risk
                reversalRisk = Math.max(reversalRisk, reversalRisk + 0.15);
            }
            forceCaution = true;
        }

        // ── Signal: score quality ─────────────────────────────────────────────
        if (strongScore && !forceCaution) {
            reasonCodes.add("STRONG_SCORE_GAP");
        }
        if (weakScore) {
            lateEntryRisk += 0.20;
        }

        // ── Determine action ──────────────────────────────────────────────────
        AdvisoryAction action;
        if (forceCaution) {
            action = AdvisoryAction.CAUTION;
        } else if (strongScore && (momentumSupports || "MIXED".equals(alignment) || alignment == null)) {
            action = AdvisoryAction.ALLOW;
        } else {
            action = AdvisoryAction.CAUTION;
        }

        // ── Determine risk level ──────────────────────────────────────────────
        RiskLevel riskLevel;
        if (reversalRisk >= 0.75 || (action == AdvisoryAction.CAUTION && reversalRisk >= 0.50)) {
            riskLevel = RiskLevel.HIGH;
        } else if (reversalRisk >= 0.35 || overextensionRisk >= 0.50 || action == AdvisoryAction.CAUTION) {
            riskLevel = RiskLevel.MEDIUM;
        } else {
            riskLevel = RiskLevel.LOW;
        }

        // Safety: ALLOW + HIGH is contradictory → upgrade action to CAUTION
        if (action == AdvisoryAction.ALLOW && riskLevel == RiskLevel.HIGH) {
            action = AdvisoryAction.CAUTION;
        }

        // ── Trade quality score ───────────────────────────────────────────────
        double tradeQualityScore;
        if (action == AdvisoryAction.CAUTION && riskLevel == RiskLevel.HIGH) {
            tradeQualityScore = 0.28;
        } else if (action == AdvisoryAction.CAUTION) {
            tradeQualityScore = 0.48;
        } else {
            tradeQualityScore = 0.70;
        }

        // ── Confidence ────────────────────────────────────────────────────────
        double confidence = 0.60;
        if (momentumOpposes)  confidence -= 0.10;
        if (opp >= 4)         confidence -= 0.05;
        if (strongScore)      confidence += 0.10;
        if (isOppositeWinner) confidence -= 0.05;
        confidence = Math.max(0.40, Math.min(0.80, confidence));

        // ── Triple candle headwind override: CAUTION → AVOID ─────────────────
        if (action == AdvisoryAction.CAUTION
                && momentumOpposes
                && opp >= 4
                && Boolean.FALSE.equals(req.getLastCandleSupportsTrade())) {
            action = AdvisoryAction.AVOID;
            riskLevel = RiskLevel.HIGH;
            tradeQualityScore = 0.20;
            reasonCodes.add("STRONG_CANDLE_OPPOSITION");
            summaryParts.add("triple candle headwind (opposeCount=" + opp + ", lastCandle opposes, momentum OPPOSES_TRADE) — avoid entry");
        }

        // ── Build summary ─────────────────────────────────────────────────────
        String summary;
        if (summaryParts.isEmpty()) {
            summary = action == AdvisoryAction.ALLOW
                    ? "Strong score gap with aligned candles — setup looks acceptable."
                    : "Elevated risk without strong confirmation — caution advised.";
        } else {
            String joined = String.join("; ", summaryParts);
            summary = Character.toUpperCase(joined.charAt(0)) + joined.substring(1) + ".";
        }

        return new AdvisoryAiOutput(action, confidence, tradeQualityScore, riskLevel,
                reversalRisk, 0.0, lateEntryRisk, overextensionRisk,
                List.copyOf(reasonCodes), List.copyOf(warningCodes), summary);
    }

    /**
     * Deterministic market context evaluation when OpenAI is disabled or unavailable.
     *
     * Step 1 — marketTradable (regime-based):
     *   COMPRESSION → false (confidence 0.80)
     *   RANGING     → false (confidence 0.65)
     *   TRENDING + adx >= 25 → true (confidence 0.65)
     *   default → true (confidence 0.50)
     *
     * Step 2 — avoidCE / avoidPE (independent of marketTradable):
     *   downCandlesCount >= 4 → avoidCE=true (confidence max 0.70)
     *   upCandlesCount >= 4   → avoidPE=true (confidence max 0.70)
     *
     * COMPRESSION/RANGING rules always preserve marketTradable=false even if candle rules fire.
     */
    MarketContextResponse marketContext(MarketContextRequest req) {
        String regime = req.getRegime();

        boolean marketTradable = true;
        boolean avoidCE = false;
        boolean avoidPE = false;
        double  confidence = 0.50;
        List<String> reasonCodes  = new ArrayList<>();
        List<String> warningCodes = new ArrayList<>();

        // ── Step 1: marketTradable via regime ────────────────────────────────
        boolean regimeLocked = false;
        if ("COMPRESSION".equalsIgnoreCase(regime)) {
            marketTradable = false;
            confidence     = Math.max(confidence, 0.80);
            reasonCodes.add("COMPRESSION_REGIME");
            regimeLocked = true;
        } else if ("RANGING".equalsIgnoreCase(regime)) {
            marketTradable = false;
            confidence     = Math.max(confidence, 0.65);
            reasonCodes.add("RANGING_REGIME");
            regimeLocked = true;
        } else if ("TRENDING".equalsIgnoreCase(regime)
                && req.getAdx() != null && req.getAdx() >= 25.0) {
            marketTradable = true;
            confidence     = Math.max(confidence, 0.65);
            reasonCodes.add("TRENDING_STRONG_ADX");
        }

        // ── Step 2: avoidCE / avoidPE (candle flow, regime-independent) ─────
        if (req.getDownCandlesCount() >= 4) {
            avoidCE    = true;
            confidence = Math.max(confidence, 0.70);
            reasonCodes.add("BEARISH_CANDLE_FLOW");
        }
        if (req.getUpCandlesCount() >= 4) {
            avoidPE    = true;
            confidence = Math.max(confidence, 0.70);
            reasonCodes.add("BULLISH_CANDLE_FLOW");
        }

        // COMPRESSION / RANGING always lock marketTradable=false even if candle rules are present
        if (regimeLocked) {
            marketTradable = false;
        }

        // ── Build summary ────────────────────────────────────────────────────
        String summary;
        if (!marketTradable && reasonCodes.contains("COMPRESSION_REGIME")) {
            summary = "Compression regime detected — high chop risk, market not tradable.";
        } else if (!marketTradable && reasonCodes.contains("RANGING_REGIME")) {
            summary = "Ranging regime detected — directional edge absent, market not tradable.";
        } else if (reasonCodes.contains("TRENDING_STRONG_ADX")) {
            summary = "Trending regime with strong ADX — market tradable"
                    + (avoidCE || avoidPE ? "; candle flow caution applied." : ".");
        } else if (avoidCE && avoidPE) {
            summary = "Mixed candle flow — both CE and PE entries cautioned.";
        } else if (avoidCE) {
            summary = "Bearish candle flow (" + req.getDownCandlesCount() + "/5 down candles) — CE entry cautioned.";
        } else if (avoidPE) {
            summary = "Bullish candle flow (" + req.getUpCandlesCount() + "/5 up candles) — PE entry cautioned.";
        } else {
            summary = "No strong directional signal — default market context, proceed normally.";
        }

        return MarketContextResponse.builder()
                .marketTradable(marketTradable)
                .avoidCE(avoidCE)
                .avoidPE(avoidPE)
                .confidence(confidence)
                .summary(summary)
                .reasonCodes(List.copyOf(reasonCodes))
                .warningCodes(List.copyOf(warningCodes))
                .source("FALLBACK")
                .build();
    }

    private String tradeLabel(String optType) {
        if ("CE".equalsIgnoreCase(optType)) return "CE (bullish call)";
        if ("PE".equalsIgnoreCase(optType)) return "PE (bearish put)";
        return "trade";
    }

    /**
     * Deterministic review when OpenAI is disabled or unavailable.
     */
    TradeReviewAiOutput review(CompletedTradeRequest req) {
        BigDecimal pnl = req.getPnl();

        if (pnl == null) {
            return TradeReviewAiOutput.unknown();
        }

        if (pnl.compareTo(BigDecimal.ZERO) > 0) {
            return new TradeReviewAiOutput(
                    TradeQuality.GOOD, false, MistakeType.NONE,
                    0.6, "Trade was profitable.",
                    List.of("PROFITABLE"), List.of(), "",
                    List.of(), List.of()
            );
        } else if (pnl.compareTo(BigDecimal.ZERO) == 0) {
            return new TradeReviewAiOutput(
                    TradeQuality.AVERAGE, false, MistakeType.NONE,
                    0.5, "Trade broke even (zero P&L).",
                    List.of(), List.of("DEAD_TRADE"), "",
                    List.of(), List.of()
            );
        } else {
            return new TradeReviewAiOutput(
                    TradeQuality.BAD, true, MistakeType.UNKNOWN,
                    0.6, "Trade resulted in a loss.",
                    List.of(), List.of("LOSS"), "",
                    List.of(), List.of()
            );
        }
    }
}
