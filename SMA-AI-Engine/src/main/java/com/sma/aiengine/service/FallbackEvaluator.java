package com.sma.aiengine.service;

import com.sma.aiengine.model.enums.*;
import com.sma.aiengine.model.request.CompletedTradeRequest;
import com.sma.aiengine.model.request.TradeCandidateRequest;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.List;

@Component
class FallbackEvaluator {

    /**
     * Deterministic advisory when OpenAI is disabled or unavailable.
     * Rules evaluated top-to-bottom; first match wins.
     */
    AdvisoryAiOutput advisory(TradeCandidateRequest req) {
        String regime = req.getRegime();

        // 1. Compression → AVOID (high chop risk)
        if ("COMPRESSION".equalsIgnoreCase(regime)) {
            return new AdvisoryAiOutput(
                    AdvisoryAction.AVOID, 0.8, 0.2, RiskLevel.HIGH,
                    0.0, 0.9, 0.0, 0.0,
                    List.of("COMPRESSION_REGIME"), List.of(),
                    "Compression regime detected — high chop risk, avoid entry."
            );
        }

        // 2. Overextended recent move → CAUTION
        Double move3 = req.getRecentMove3CandlePct();
        if (move3 != null && move3 > 1.5) {
            return new AdvisoryAiOutput(
                    AdvisoryAction.CAUTION, 0.6, 0.4, RiskLevel.MEDIUM,
                    0.0, 0.0, 0.0, 0.8,
                    List.of("OVEREXTENDED_MOVE"), List.of(),
                    "Recent 3-candle move exceeds 1.5% — overextension risk, proceed with caution."
            );
        }

        // 3. Strong score gap with non-compression regime → ALLOW
        Double winningScore = req.getWinningScore();
        Double scoreGap     = req.getScoreGap();
        if (winningScore != null && scoreGap != null
                && winningScore >= 30.0 && scoreGap >= 8.0
                && !"COMPRESSION".equalsIgnoreCase(regime)) {
            return new AdvisoryAiOutput(
                    AdvisoryAction.ALLOW, 0.7, 0.7, RiskLevel.LOW,
                    0.0, 0.0, 0.0, 0.0,
                    List.of("STRONG_SCORE_GAP"), List.of(),
                    "Strong winning score with clear gap — setup looks acceptable."
            );
        }

        // 4. Insufficient data or no rule matched
        return AdvisoryAiOutput.unknown();
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
