package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.service.StrategyScorer;
import com.sma.strategyengine.strategy.PositionDirection;
import com.sma.strategyengine.strategy.StrategyContext;
import com.sma.strategyengine.strategy.StrategyRegistry;
import com.sma.strategyengine.strategy.StrategyResult;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;

import java.time.Instant;
import java.time.ZoneId;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Stateful per-session NIFTY-only decision engine.
 *
 * Create one instance per replay session; call {@link #warmup(List)} with
 * pre-replay candles, then call {@link #evaluate(CandleDto, String)} for
 * each replay candle to get a {@link NiftyDecisionResult}.
 *
 * All strategies are evaluated every candle — including those that return HOLD —
 * so the candidate list always shows the full scoring picture.
 */
@Slf4j
public class NiftyDecisionEngine {

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private final StrategyRegistry                       registry;
    private final List<BacktestRequest.StrategyConfig>   strategies;
    private final OptionsReplayRequest.DecisionConfig    dc;
    private final OptionsReplayRequest.SwitchConfig      sc;
    private final OptionsReplayRequest.RegimeRules          rr;
    private final OptionsReplayRequest.RegimeStrategyRules  rsr;
    private final OptionsReplayRequest.ChopRules            cr;
    private final RangeQualityFilter                        rqf;
    private final OptionsReplayRequest.TradeQualityConfig   tqc;
    private final TrendEntryValidator                       tev;
    private final CompressionEntryValidator                 cev;

    // Score that was active when current confirmedBias was locked in (for switch improvement check)
    private double confirmedBiasScore = 0.0;

    // One scorer per strategy config (StrategyScorer is not Spring-managed)
    private final Map<String, StrategyScorer> scorers = new LinkedHashMap<>();
    // Unique instance IDs (strategy type -> instanceId) for state isolation
    private final Map<String, String> instanceIds = new LinkedHashMap<>();

    // Rolling candle history (needed for recent-move and chop calculations)
    private final Deque<CandleDto> history = new ArrayDeque<>(200);

    // Intraday VWAP (reset at each calendar-day boundary)
    private double pvSum   = 0;
    private double volSum  = 0;
    private String vwapDay = null;

    // Switch / confirmation state
    private NiftyDecisionResult.Bias confirmedBias = NiftyDecisionResult.Bias.NEUTRAL;
    private NiftyDecisionResult.Bias previousBias  = NiftyDecisionResult.Bias.NEUTRAL;
    private NiftyDecisionResult.Bias pendingBias   = null;
    private int    confirmCount    = 0;

    // Daily switch counter
    private int    switchCountToday = 0;
    private String currentDate      = null;

    // Aggregate replay diagnostics
    private final ReplayDiagnostics diagnostics = new ReplayDiagnostics();

    // Rolling winner-score history for early-entry rising-score detection (last 3 values)
    private final Deque<Double> winnerScoreHistory = new ArrayDeque<>(4);

    // ─────────────────────────────────────────────────────────────────────────

    public NiftyDecisionEngine(StrategyRegistry registry,
                               List<BacktestRequest.StrategyConfig> strategies,
                               OptionsReplayRequest.DecisionConfig decisionConfig,
                               OptionsReplayRequest.SwitchConfig switchConfig,
                               OptionsReplayRequest.RegimeRules regimeRules,
                               OptionsReplayRequest.RegimeStrategyRules regimeStrategyRules,
                               OptionsReplayRequest.ChopRules chopRules,
                               OptionsReplayRequest.RangeQualityConfig rangeQualityConfig,
                               OptionsReplayRequest.TradeQualityConfig tradeQualityConfig,
                               OptionsReplayRequest.TrendEntryConfig trendEntryConfig,
                               OptionsReplayRequest.CompressionEntryConfig compressionEntryConfig) {
        this.registry   = registry;
        this.strategies = strategies;
        this.dc         = decisionConfig;
        this.sc         = switchConfig;
        this.rr         = regimeRules != null ? regimeRules : new OptionsReplayRequest.RegimeRules();
        this.rsr        = regimeStrategyRules != null ? regimeStrategyRules : new OptionsReplayRequest.RegimeStrategyRules();
        this.cr         = chopRules != null ? chopRules : new OptionsReplayRequest.ChopRules();
        this.rqf        = new RangeQualityFilter(rangeQualityConfig);
        this.tqc        = tradeQualityConfig != null ? tradeQualityConfig : new OptionsReplayRequest.TradeQualityConfig();
        this.tev        = new TrendEntryValidator(trendEntryConfig);
        this.cev        = new CompressionEntryValidator(compressionEntryConfig);

        for (BacktestRequest.StrategyConfig cfg : strategies) {
            String id = "nifty-opts-" + cfg.getStrategyType() + "-" + System.nanoTime() + "-" + cfg.hashCode();
            instanceIds.put(cfg.getStrategyType(), id);
            scorers.put(cfg.getStrategyType(), new StrategyScorer());
        }
    }

    // ── Warmup ────────────────────────────────────────────────────────────────

    /**
     * Feed warmup candles to strategies and scorers (no decision output).
     * Must be called before the first {@link #evaluate} call.
     */
    public void warmup(List<CandleDto> warmupCandles) {
        for (CandleDto c : warmupCandles) {
            pushToScorersAndHistory(c);
            for (BacktestRequest.StrategyConfig cfg : strategies) {
                try {
                    StrategyContext ctx = buildContext(instanceIds.get(cfg.getStrategyType()), cfg, c);
                    registry.resolve(cfg.getStrategyType()).evaluate(ctx);
                } catch (Exception e) {
                    log.warn("Warmup strategy eval error: {}", e.getMessage());
                }
            }
        }
        log.debug("NiftyDecisionEngine warmed up with {} candles", warmupCandles.size());
    }

    // ── Per-candle evaluation ─────────────────────────────────────────────────

    public NiftyDecisionResult evaluate(CandleDto candle, String regime) {
        // Reset daily state at day boundary
        String dateStr = dayOf(candle);
        if (!dateStr.equals(currentDate)) {
            currentDate      = dateStr;
            switchCountToday = 0;
            pvSum  = 0;
            volSum = 0;
        }

        pushToScorersAndHistory(candle);
        updateVwap(candle);

        double close    = candle.close().doubleValue();
        double vwap     = volSum > 0 ? pvSum / volSum : close;
        double vwapDist = (close - vwap) / vwap * 100.0;

        // ── Resolve effective thresholds for this regime ──────────────────────
        double effMinScore    = effectiveMinScore(regime);
        double effMinScoreGap = effectiveMinScoreGap(regime);

        // ── Evaluate ALL strategies (including HOLD for full diagnostics) ──────
        List<ScoredCandidate>              signalCandidates  = new ArrayList<>();
        List<NiftyDecisionResult.CandidateScore> allCandidates = new ArrayList<>();

        Set<String> allowedForThisRegime = allowedForRegime(regime);

        for (BacktestRequest.StrategyConfig cfg : strategies) {
            String id = instanceIds.get(cfg.getStrategyType());
            try {
                // Skip strategies blocked by regime strategy rules
                if (allowedForThisRegime != null && !allowedForThisRegime.contains(cfg.getStrategyType())) {
                    StrategyScorer.ScoreResult sr = scorers.get(cfg.getStrategyType())
                            .score(cfg.getStrategyType(), true, regime, "OPTION");
                    NiftyDecisionResult.CandidateScore cs = holdCandidateScore(cfg.getStrategyType(), sr);
                    // Override eligibility reason to explain the regime filter
                    allCandidates.add(NiftyDecisionResult.CandidateScore.builder()
                            .strategyType(cs.getStrategyType()).signal("NONE")
                            .baseScore(cs.getBaseScore()).trendComponent(cs.getTrendComponent())
                            .volatilityComponent(cs.getVolatilityComponent()).momentumComponent(cs.getMomentumComponent())
                            .confidenceComponent(cs.getConfidenceComponent())
                            .penaltyReversal(cs.getPenaltyReversal()).penaltyOverextension(cs.getPenaltyOverextension())
                            .penaltySameColor(cs.getPenaltySameColor()).penaltyMismatch(cs.getPenaltyMismatch())
                            .penaltyVolatileOption(cs.getPenaltyVolatileOption()).totalPenalty(cs.getTotalPenalty())
                            .score(cs.getScore()).eligible(false)
                            .eligibilityReason("blocked by regime strategy rule")
                            .trendStrength(cs.getTrendStrength()).volatility(cs.getVolatility())
                            .momentum(cs.getMomentum()).confidence(cs.getConfidence()).penalty(cs.getPenalty())
                            .build());
                    continue;
                }

                StrategyContext ctx    = buildContext(id, cfg, candle);
                StrategyResult  result = registry.resolve(cfg.getStrategyType()).evaluate(ctx);

                if (!result.isHold()) {
                    boolean isBuy = result.isBuy();
                    StrategyScorer.ScoreResult sr = scorers.get(cfg.getStrategyType())
                            .score(cfg.getStrategyType(), isBuy, regime, "OPTION");
                    ScoredCandidate sc = new ScoredCandidate(
                            cfg.getStrategyType(),
                            isBuy ? StrategyResult.Signal.BUY : StrategyResult.Signal.SELL,
                            sr.getTotal(), sr);
                    signalCandidates.add(sc);
                    allCandidates.add(toCandidateScore(sc, effMinScore));
                } else {
                    // HOLD: score with BUY direction as a reference (shows what the scorer sees)
                    StrategyScorer.ScoreResult sr = scorers.get(cfg.getStrategyType())
                            .score(cfg.getStrategyType(), true, regime, "OPTION");
                    allCandidates.add(holdCandidateScore(cfg.getStrategyType(), sr));
                }
            } catch (Exception e) {
                log.warn("Strategy eval error [{}]: {}", cfg.getStrategyType(), e.getMessage());
            }
        }

        // ── Pick winner from signal candidates ────────────────────────────────
        // Sort by score descending for top-2 exposition
        List<ScoredCandidate> sorted = signalCandidates.stream()
                .sorted((a, b) -> Double.compare(b.score, a.score))
                .collect(Collectors.toList());

        ScoredCandidate top1 = sorted.isEmpty()      ? null : sorted.get(0);
        ScoredCandidate top2 = sorted.size() > 1     ? sorted.get(1) : null;

        ScoredCandidate winner = signalCandidates.stream()
                .filter(c -> c.score >= effMinScore)
                .max(Comparator.comparingDouble(c -> c.score))
                .orElse(null);

        double winnerScore = winner != null ? winner.score : 0;
        double secondScore = top2  != null ? top2.score   : 0;
        double scoreGap    = winnerScore - secondScore;

        // ── Raw bias ──────────────────────────────────────────────────────────
        NiftyDecisionResult.Bias rawBias = NiftyDecisionResult.Bias.NEUTRAL;
        if (winner != null && scoreGap >= effMinScoreGap) {
            rawBias = winner.signal == StrategyResult.Signal.BUY
                    ? NiftyDecisionResult.Bias.BULLISH
                    : NiftyDecisionResult.Bias.BEARISH;
        }

        // ── Neutral reason ────────────────────────────────────────────────────
        String neutralReason = null;
        if (rawBias == NiftyDecisionResult.Bias.NEUTRAL) {
            if (signalCandidates.isEmpty()) {
                neutralReason = "NO_SIGNALS";
            } else if (winner == null) {
                neutralReason = "ALL_SIGNALS_BELOW_SCORE";
            } else {
                neutralReason = "SCORE_GAP_TOO_SMALL";
            }
        }

        // ── Shadow winner — best signal candidate regardless of thresholds ────
        String shadowWinner              = null;
        double shadowWinnerScore         = 0;
        String shadowWinnerReasonNotTaken = null;
        if (top1 != null) {
            shadowWinner      = top1.strategyType;
            shadowWinnerScore = top1.score;
            if (rawBias != NiftyDecisionResult.Bias.NEUTRAL) {
                shadowWinnerReasonNotTaken = "selected as winner";
            } else if (top1.score < effMinScore) {
                shadowWinnerReasonNotTaken = String.format(
                        "score %.1f < minScore %.1f", top1.score, effMinScore);
            } else {
                // Score was fine but gap too small
                double rawGap = top1.score - (top2 != null ? top2.score : 0);
                shadowWinnerReasonNotTaken = String.format(
                        "scoreGap %.1f < minScoreGap %.1f", rawGap, effMinScoreGap);
            }
        } else if (!allCandidates.isEmpty()) {
            shadowWinnerReasonNotTaken = "all strategies returned HOLD";
        }

        // ── Entry decision with penalty system ───────────────────────────────
        double move3 = recentMovePct(3);
        double move5 = recentMovePct(5);

        String  block          = null;
        boolean canEnter       = false;
        double  penalizedScore = winnerScore;

        if (rawBias == NiftyDecisionResult.Bias.NEUTRAL || winnerScore <= 0) {
            // Absolute block: no directional signal
            block    = "no directional signal";
            canEnter = false;
        } else if (winnerScore < 15) {
            // Absolute block: score below floor
            block    = String.format("score %.1f below absolute floor (15)", winnerScore);
            canEnter = false;
        } else {
            EntryPenalties ep = computeEntryPenalties(move3, move5, Math.abs(vwapDist), regime);
            penalizedScore = winnerScore + ep.total; // total is <= 0

            // 40% penalty cap: total penalties cannot reduce score below 60% of raw winnerScore
            penalizedScore = Math.max(penalizedScore, winnerScore * 0.60);

            // Score floor: if raw score ≥ scoreFloorTrigger, penalties cannot push penalized below scoreFloorMin
            if (winnerScore >= dc.getScoreFloorTrigger() && dc.getScoreFloorMin() > 0) {
                penalizedScore = Math.max(penalizedScore, dc.getScoreFloorMin());
            }

            // BOLLINGER bonus: if winner is BOLLINGER_REVERSION and score ≥ bollingerBonusThreshold, add bonus
            if (winner != null
                    && "BOLLINGER_REVERSION".equals(winner.strategyType)
                    && winnerScore >= dc.getBollingerBonusThreshold()
                    && dc.getBollingerBonus() != 0) {
                penalizedScore += dc.getBollingerBonus();
                log.debug("BOLLINGER bonus +{} applied, penalizedScore → {}",
                        dc.getBollingerBonus(), String.format("%.1f", penalizedScore));
            }

            // Early entry: score has risen for earlyEntryRisingBars consecutive candles → allow even below threshold
            boolean earlyEntryByRisingScore = false;
            if (dc.getEarlyEntryRisingBars() > 0 && winnerScoreHistory.size() >= dc.getEarlyEntryRisingBars()) {
                Double[] hist = winnerScoreHistory.toArray(new Double[0]);
                int n = hist.length;
                boolean allRising = true;
                for (int idx = n - dc.getEarlyEntryRisingBars(); idx < n - 1; idx++) {
                    if (hist[idx + 1] <= hist[idx]) { allRising = false; break; }
                }
                if (allRising && winnerScore > hist[n - dc.getEarlyEntryRisingBars()]) {
                    earlyEntryByRisingScore = true;
                    log.debug("EARLY_ENTRY rising score {} bars: {} → {}",
                            dc.getEarlyEntryRisingBars(), hist[n - dc.getEarlyEntryRisingBars()],
                            String.format("%.1f", winnerScore));
                }
            }

            // Item 5 — Entry floor bypass: raw score ≥ threshold AND gap ≥ floor → allow regardless of penalized
            boolean rawScoreBypass = dc.getRawScoreBypassThreshold() > 0
                    && winnerScore >= dc.getRawScoreBypassThreshold()
                    && scoreGap >= dc.getRawScoreBypassGap();
            if (rawScoreBypass) {
                log.debug("RAW_SCORE_BYPASS raw={} gap={} (need raw≥{} gap≥{})",
                        String.format("%.1f", winnerScore), String.format("%.1f", scoreGap),
                        dc.getRawScoreBypassThreshold(), dc.getRawScoreBypassGap());
            }

            // Item 7 — Safe guard: use max(rawScore, penalizedScore) vs threshold
            double effectiveScore = Math.max(winnerScore, penalizedScore);

            if (effectiveScore >= dc.getPenaltyMinScore() || earlyEntryByRisingScore || rawScoreBypass) {
                canEnter = true;
                if (!ep.breakdown.isEmpty()) {
                    log.debug("entry ok — {}", ep.logLine(penalizedScore));
                }
            } else {
                canEnter = false;
                block    = ep.blockReason(penalizedScore, dc.getPenaltyMinScore());
            }
        }

        // Track winner score history for early-entry rising-score window
        winnerScoreHistory.addLast(winnerScore);
        if (winnerScoreHistory.size() > 4) winnerScoreHistory.removeFirst();

        // ── Structure validation (TRENDING / COMPRESSION) ────────────────────
        if (canEnter) {
            List<CandleDto> histList = new ArrayList<>(history);
            if ("TRENDING".equals(regime)) {
                TrendEntryValidator.Result tr = tev.validate(histList, rawBias);
                if (!tr.isAllowed()) {
                    canEnter = false;
                    block    = "TREND:" + tr.getReason();
                }
            } else if ("COMPRESSION".equals(regime)) {
                CompressionEntryValidator.Result cvr = cev.validate(histList, rawBias);
                if (!cvr.isAllowed()) {
                    canEnter = false;
                    block    = "COMPRESSION:" + cvr.getReason();
                }
            }
        }

        // ── Trade quality tier ────────────────────────────────────────────────
        String tradeStrength;
        if (rawBias == NiftyDecisionResult.Bias.NEUTRAL || winnerScore <= 0 || !canEnter) {
            tradeStrength = "NONE";
        } else if (penalizedScore >= tqc.getStrongScoreThreshold()) {
            tradeStrength = "STRONG";
        } else if (penalizedScore >= tqc.getNormalScoreThreshold()) {
            tradeStrength = "NORMAL";
        } else if (penalizedScore >= dc.getPenaltyMinScore()) {
            tradeStrength = "WEAK";
        } else {
            tradeStrength = "NONE";
        }

        // ── Switch / confirmation ─────────────────────────────────────────────
        // Regime-based confirmation candles: RANGING needs more conviction
        int confirmRequired = sc.getSwitchConfirmationCandles();
        if (tqc.isEnabled()) {
            if ("RANGING".equals(regime)) {
                confirmRequired = tqc.getRangingConfirmCandles();
            } else if ("TRENDING".equals(regime) || "COMPRESSION".equals(regime)) {
                confirmRequired = tqc.getTrendingConfirmCandles();
            }
        }
        // Item 6 — BOLLINGER early reversal: score ≥ bollingerEarlyEntryMinScore → bypass to 1-candle confirm
        if (winner != null && "BOLLINGER_REVERSION".equals(winner.strategyType)
                && dc.getBollingerEarlyEntryMinScore() > 0
                && winnerScore >= dc.getBollingerEarlyEntryMinScore()) {
            confirmRequired = Math.min(confirmRequired, 1);
            log.debug("BOLLINGER_EARLY_CONFIRM: confirmRequired overridden to 1 (score={})",
                    String.format("%.1f", winnerScore));
        }

        boolean switchRequested = rawBias != NiftyDecisionResult.Bias.NEUTRAL
                && rawBias != confirmedBias;
        boolean switchConfirmed = false;
        String  switchReason    = null;

        if (rawBias == confirmedBias) {
            pendingBias  = null;
            confirmCount = 0;
        } else if (rawBias == NiftyDecisionResult.Bias.NEUTRAL) {
            if (pendingBias == NiftyDecisionResult.Bias.NEUTRAL) {
                confirmCount++;
            } else {
                pendingBias  = NiftyDecisionResult.Bias.NEUTRAL;
                confirmCount = 1;
            }
            if (confirmCount >= confirmRequired
                    && confirmedBias != NiftyDecisionResult.Bias.NEUTRAL) {
                switchConfirmed      = true;
                switchReason         = "neutral confirmed — bias invalidated";
                previousBias         = confirmedBias;
                confirmedBias        = NiftyDecisionResult.Bias.NEUTRAL;
                confirmedBiasScore   = 0.0;
                pendingBias          = null;
                confirmCount         = 0;
            }
        } else {
            if (pendingBias == rawBias) {
                confirmCount++;
            } else {
                pendingBias  = rawBias;
                confirmCount = 1;
            }
            // Require score to have improved over the score that locked in the prior bias
            boolean scoreImprovementOk = sc.getMinScoreImprovementForSwitch() <= 0
                    || winnerScore >= confirmedBiasScore + sc.getMinScoreImprovementForSwitch();
            if (confirmCount >= confirmRequired
                    && winnerScore >= effMinScore
                    && scoreGap >= effMinScoreGap
                    && scoreImprovementOk) {
                switchConfirmed      = true;
                switchReason         = "bias confirmed for " + confirmCount + " candles";
                previousBias         = confirmedBias;
                confirmedBias        = rawBias;
                confirmedBiasScore   = winnerScore;
                pendingBias          = null;
                confirmCount         = 0;
            }
        }

        String confidence = winnerScore >= 75 ? "HIGH"
                : winnerScore >= 55 ? "MEDIUM"
                : winnerScore >= effMinScore ? "LOW" : "NONE";

        // ── Update aggregate diagnostics ──────────────────────────────────────
        updateDiagnostics(signalCandidates, effMinScore, rawBias, neutralReason, block, move3, move5, Math.abs(vwapDist));

        return NiftyDecisionResult.builder()
                .rawBias(rawBias)
                .confirmedBias(confirmedBias)
                .previousBias(previousBias)
                .winnerStrategy(winner != null ? winner.strategyType : null)
                .winnerScore(winnerScore)
                .scoreGap(scoreGap)
                .confidenceLevel(confidence)
                .regime(regime)
                .recentMove3(move3)
                .recentMove5(move5)
                .distanceFromVwap(vwapDist)
                .vwap(vwap)
                .entryAllowed(canEnter)
                .blockReason(block)
                .penalizedScore(penalizedScore)
                .tradeStrength(tradeStrength)
                .neutralReason(neutralReason)
                .effectiveMinScore(effMinScore)
                .effectiveMinScoreGap(effMinScoreGap)
                // Top-2
                .secondStrategy(top2 != null ? top2.strategyType : null)
                .secondScore(secondScore)
                // Shadow winner
                .shadowWinner(shadowWinner)
                .shadowWinnerScore(shadowWinnerScore)
                .shadowWinnerReasonNotTaken(shadowWinnerReasonNotTaken)
                // Switch
                .switchRequested(switchRequested)
                .switchConfirmed(switchConfirmed)
                .confirmCount(confirmCount)
                .confirmRequired(confirmRequired)
                .switchReason(switchReason)
                .switchCountToday(switchCountToday)
                // Full candidate list (all strategies, including HOLD)
                .candidates(allCandidates)
                .build();
    }

    public void incrementSwitchCount() { switchCountToday++; }

    /** Returns the aggregate diagnostics collected across all evaluated candles. */
    public ReplayDiagnostics getDiagnostics() { return diagnostics; }

    /** Clean up per-instance strategy state when session ends. */
    public void cleanup() {
        for (BacktestRequest.StrategyConfig cfg : strategies) {
            String id = instanceIds.get(cfg.getStrategyType());
            try {
                registry.resolve(cfg.getStrategyType()).onInstanceRemoved(id);
            } catch (Exception ignored) {}
        }
    }

    // ── Candidate score builders ──────────────────────────────────────────────

    private NiftyDecisionResult.CandidateScore toCandidateScore(
            ScoredCandidate sc, double minScore) {
        StrategyScorer.ScoreResult sr = sc.sr;
        boolean eligible = sc.score >= minScore;
        String reason = eligible ? null
                : String.format("score %.1f < minScore %.1f", sc.score, minScore);
        return NiftyDecisionResult.CandidateScore.builder()
                .strategyType(sc.strategyType)
                .signal(sc.signal.name())
                .baseScore(sr.getBaseScore())
                .trendComponent(sr.getTrendStrength())
                .volatilityComponent(sr.getVolatilityScore())
                .momentumComponent(sr.getMomentumScore())
                .confidenceComponent(sr.getConfidenceScore())
                .penaltyReversal(sr.getReversalPenalty())
                .penaltyOverextension(sr.getOverextensionPenalty())
                .penaltySameColor(sr.getSameColorPenalty())
                .penaltyMismatch(sr.getInstrumentMismatchPenalty())
                .penaltyVolatileOption(sr.getVolatileOptionPenalty())
                .totalPenalty(sr.getTotalPenalty())
                .score(sc.score)
                .eligible(eligible)
                .eligibilityReason(reason)
                // Legacy aliases
                .trendStrength(sr.getTrendStrength())
                .volatility(sr.getVolatilityScore())
                .momentum(sr.getMomentumScore())
                .confidence(sr.getConfidenceScore())
                .penalty(sr.getTotalPenalty())
                .build();
    }

    private NiftyDecisionResult.CandidateScore holdCandidateScore(
            String strategyType, StrategyScorer.ScoreResult sr) {
        return NiftyDecisionResult.CandidateScore.builder()
                .strategyType(strategyType)
                .signal("NONE")
                .baseScore(sr.getBaseScore())
                .trendComponent(sr.getTrendStrength())
                .volatilityComponent(sr.getVolatilityScore())
                .momentumComponent(sr.getMomentumScore())
                .confidenceComponent(sr.getConfidenceScore())
                .penaltyReversal(sr.getReversalPenalty())
                .penaltyOverextension(sr.getOverextensionPenalty())
                .penaltySameColor(sr.getSameColorPenalty())
                .penaltyMismatch(sr.getInstrumentMismatchPenalty())
                .penaltyVolatileOption(sr.getVolatileOptionPenalty())
                .totalPenalty(sr.getTotalPenalty())
                .score(sr.getTotal())
                .eligible(false)
                .eligibilityReason("strategy returned HOLD")
                // Legacy aliases
                .trendStrength(sr.getTrendStrength())
                .volatility(sr.getVolatilityScore())
                .momentum(sr.getMomentumScore())
                .confidence(sr.getConfidenceScore())
                .penalty(sr.getTotalPenalty())
                .build();
    }

    // ── Regime-aware threshold resolution ────────────────────────────────────

    private double effectiveMinScore(String regime) {
        if (!rr.isEnabled() || regime == null) return dc.getMinScore();
        return switch (regime) {
            case "RANGING"     -> rr.getRangingMinScore();
            case "TRENDING"    -> rr.getTrendingMinScore();
            case "COMPRESSION" -> rr.getCompressionMinScore();
            default            -> dc.getMinScore();
        };
    }

    private double effectiveMinScoreGap(String regime) {
        if (!rr.isEnabled() || regime == null) return dc.getMinScoreGap();
        return switch (regime) {
            case "RANGING"     -> rr.getRangingMinScoreGap();
            case "TRENDING"    -> rr.getTrendingMinScoreGap();
            case "COMPRESSION" -> rr.getCompressionMinScoreGap();
            default            -> dc.getMinScoreGap();
        };
    }

    /**
     * Returns the allowed strategy set for the current regime, or {@code null}
     * if no restriction is configured (all strategies are allowed).
     */
    private Set<String> allowedForRegime(String regime) {
        if (!rsr.isEnabled() || regime == null) return null;
        List<String> list = switch (regime) {
            case "RANGING"     -> rsr.getRanging();
            case "TRENDING"    -> rsr.getTrending();
            case "COMPRESSION" -> rsr.getCompression();
            case "VOLATILE"    -> rsr.getVolatileRegime();
            default            -> null;
        };
        return (list != null && !list.isEmpty()) ? new HashSet<>(list) : null;
    }

    // ── Aggregate diagnostics ─────────────────────────────────────────────────

    private void updateDiagnostics(List<ScoredCandidate> signals,
                                   double effMinScore,
                                   NiftyDecisionResult.Bias rawBias,
                                   String neutralReason,
                                   String block,
                                   double move3, double move5, double absVwap) {
        diagnostics.totalCandles++;
        if (signals.stream().anyMatch(c -> c.signal == StrategyResult.Signal.BUY))
            diagnostics.candlesWithBuyCandidate++;
        if (signals.stream().anyMatch(c -> c.signal == StrategyResult.Signal.SELL))
            diagnostics.candlesWithSellCandidate++;
        if (signals.stream().anyMatch(c -> c.score >= effMinScore))
            diagnostics.candlesWithEligibleCandidate++;

        if (rawBias != NiftyDecisionResult.Bias.NEUTRAL) {
            diagnostics.candlesWithWinner++;
        } else {
            diagnostics.candlesNeutral++;
            if (neutralReason != null)
                diagnostics.neutralReasonCounts.merge(neutralReason, 1, Integer::sum);
        }

        // Entry-block tracking (non-neutral bias that got blocked)
        if (block != null && rawBias != NiftyDecisionResult.Bias.NEUTRAL) {
            if (block.contains("move=-5"))         diagnostics.candlesBlockedByRecentMove++;
            if (block.contains("vwap=-5"))         diagnostics.candlesBlockedByVwap++;
            if (block.contains("chop=-8"))         diagnostics.candlesBlockedByChop++;
            if (block.contains("after penalties")) diagnostics.candlesBlockedByPenalty++;
            if (block.startsWith("TREND:"))        diagnostics.candlesBlockedByTrendStructure++;
            if (block.startsWith("COMPRESSION:")) diagnostics.candlesBlockedByCompressionStructure++;
        }

        // Score-level blocking (captured via neutralReason)
        if ("ALL_SIGNALS_BELOW_SCORE".equals(neutralReason))
            diagnostics.candlesBlockedByScore++;
        if ("SCORE_GAP_TOO_SMALL".equals(neutralReason))
            diagnostics.candlesBlockedByScoreGap++;
        if ("NO_SIGNALS".equals(neutralReason))
            diagnostics.candlesNoSignals++;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void pushToScorersAndHistory(CandleDto c) {
        double o  = c.open().doubleValue();
        double h  = c.high().doubleValue();
        double l  = c.low().doubleValue();
        double cl = c.close().doubleValue();
        for (StrategyScorer s : scorers.values()) s.push(o, h, l, cl);
        history.addLast(c);
        if (history.size() > 150) history.removeFirst();
    }

    private void updateVwap(CandleDto c) {
        double tp  = (c.high().doubleValue() + c.low().doubleValue() + c.close().doubleValue()) / 3.0;
        double vol = c.volume() != null ? c.volume().doubleValue() : 0;
        pvSum  += tp * vol;
        volSum += vol;
    }

    private StrategyContext buildContext(String instanceId,
                                        BacktestRequest.StrategyConfig cfg,
                                        CandleDto c) {
        Instant ts = c.openTime() != null
                ? c.openTime().atZone(IST).toInstant()
                : Instant.now();
        return StrategyContext.builder()
                .instanceId(instanceId)
                .strategyType(cfg.getStrategyType())
                .userId("opts-replay")
                .brokerName("kite")
                .symbol("NIFTY 50")
                .exchange("NSE")
                .product("MIS")
                .quantity(1)
                .orderType("MARKET")
                .currentDirection(PositionDirection.FLAT)
                .allowShorting(false)
                .candleOpenTime(ts)
                .candleOpen(c.open())
                .candleHigh(c.high())
                .candleLow(c.low())
                .candleClose(c.close())
                .candleVolume(c.volume() != null ? c.volume() : 0L)
                .params(cfg.getParameters() != null ? cfg.getParameters() : Map.of())
                .build();
    }

    /**
     * Compute entry penalties for all soft filter conditions.
     * Hard blocks (NEUTRAL bias, score < 15) are handled upstream.
     */
    private EntryPenalties computeEntryPenalties(double m3, double m5, double absVwap, String regime) {
        EntryPenalties ep = new EntryPenalties();

        boolean isRanging = "RANGING".equals(regime);

        // Move / over-extension penalty (-3, reduced from -5)
        if (m3 > dc.getMaxRecentMove3() || m5 > dc.getMaxRecentMove5())
            ep.add("move", -3);

        // VWAP distance penalty (-5)
        if (absVwap > dc.getMaxAbsVwapDist())
            ep.add("vwap", -5);

        // Chop penalty: disabled in RANGING; -2 in other regimes (reduced from -4)
        if (!isRanging && dc.isChopFilter() && isChopFilterActiveForRegime(regime)
                && isChoppy(chopFlipRatioForRegime(regime)))
            ep.add("chop", -2);

        // Range quality penalties (RANGING only)
        if (isRanging) {
            RangeQualityFilter.Result rq = rqf.evaluate(history);
            if (!rq.isAllowed()) {
                String reason = rq.getReason();
                double penalty = reason.startsWith("RANGE_DRIFTING")       ? -3   // 50% cut from -5 (RANGING fix)
                               : reason.startsWith("RANGE_POOR_STRUCTURE") ? -4
                               : reason.startsWith("RANGE_CHOPPY")         ? -2   // halved (chop reduced in RANGING)
                               : -2; // TOO_NARROW, TOO_WIDE (reduced from -5)
                String label = reason.contains(":") ? reason.substring(0, reason.indexOf(':')) : reason;
                ep.add(label.toLowerCase().replace("range_", ""), penalty);
            }
        }

        return ep;
    }

    /** Returns false if the per-regime chop rule disables the filter for this regime. */
    private boolean isChopFilterActiveForRegime(String regime) {
        if (!cr.isEnabled() || regime == null) return true;
        OptionsReplayRequest.ChopRules.RegimeChop rc = chopRuleFor(regime);
        return rc == null || rc.isFilterEnabled();
    }

    /** Returns the flip ratio to use for this regime (falls back to 0.65 if no override). */
    private double chopFlipRatioForRegime(String regime) {
        if (!cr.isEnabled() || regime == null) return 0.65;
        OptionsReplayRequest.ChopRules.RegimeChop rc = chopRuleFor(regime);
        return rc != null ? rc.getFlipRatio() : 0.65;
    }

    private OptionsReplayRequest.ChopRules.RegimeChop chopRuleFor(String regime) {
        return switch (regime) {
            case "RANGING"     -> cr.getRanging();
            case "TRENDING"    -> cr.getTrending();
            case "COMPRESSION" -> cr.getCompression();
            case "VOLATILE"    -> cr.getVolatileRegime();
            default            -> null;
        };
    }

    private boolean isChoppy(double flipRatio) {
        int n = dc.getChopLookback();
        List<CandleDto> recent = new ArrayList<>(history);
        if (recent.size() < n) return false;
        recent = recent.subList(recent.size() - n, recent.size());
        int flips = 0;
        for (int i = 2; i < recent.size(); i++) {
            double p0 = recent.get(i - 2).close().doubleValue();
            double p1 = recent.get(i - 1).close().doubleValue();
            double p2 = recent.get(i).close().doubleValue();
            boolean prevUp = p1 > p0;
            boolean currUp = p2 > p1;
            if (prevUp != currUp) flips++;
        }
        return flips >= (n - 2) * flipRatio;
    }

    private double recentMovePct(int n) {
        List<CandleDto> hist = new ArrayList<>(history);
        if (hist.size() < n + 1) return 0;
        double start = hist.get(hist.size() - n - 1).close().doubleValue();
        double end   = hist.get(hist.size() - 1).close().doubleValue();
        return start > 0 ? Math.abs((end - start) / start * 100.0) : 0;
    }

    private String dayOf(CandleDto c) {
        if (c.openTime() == null) return "unknown";
        return c.openTime().toLocalDate().toString();
    }

    // ── Inner types ───────────────────────────────────────────────────────────

    /** Accumulates score penalties for soft entry conditions. */
    private static class EntryPenalties {
        double total = 0;
        final List<String> breakdown = new ArrayList<>();

        void add(String label, double penalty) {
            total += penalty;
            breakdown.add(label + "=" + (int) penalty);
        }

        /** Log line: "penalties: chop=-8, drift=-10 → finalScore=27.0" */
        String logLine(double finalScore) {
            return "penalties: " + String.join(", ", breakdown)
                    + " → finalScore=" + String.format("%.1f", finalScore);
        }

        /** Block reason shown in the feed. */
        String blockReason(double finalScore, double threshold) {
            return String.format("score %.1f after penalties [%s] < threshold %.1f",
                    finalScore, String.join(", ", breakdown), threshold);
        }
    }

    private static class ScoredCandidate {
        final String strategyType;
        final StrategyResult.Signal signal;
        final double score;
        final StrategyScorer.ScoreResult sr;
        ScoredCandidate(String t, StrategyResult.Signal s, double sc, StrategyScorer.ScoreResult r) {
            this.strategyType = t; this.signal = s; this.score = sc; this.sr = r;
        }
    }

    /**
     * Aggregate diagnostics collected over a full replay session.
     * Serialised to JSON and included in the final "summary" SSE event.
     */
    @Data
    public static class ReplayDiagnostics {
        int totalCandles;
        int candlesWithBuyCandidate;
        int candlesWithSellCandidate;
        int candlesWithEligibleCandidate;   // score >= minScore
        int candlesWithWinner;              // rawBias != NEUTRAL
        int candlesNeutral;
        int candlesNoSignals;               // all strategies held
        int candlesBlockedByScore;          // ALL_SIGNALS_BELOW_SCORE
        int candlesBlockedByScoreGap;       // SCORE_GAP_TOO_SMALL
        int candlesBlockedByRecentMove;           // move penalty contributed to penalty block
        int candlesBlockedByVwap;                 // VWAP penalty contributed to penalty block
        int candlesBlockedByChop;                 // chop penalty contributed to penalty block
        int candlesBlockedByPenalty;              // total penalty blocks (penalized score < threshold)
        int candlesBlockedByTrendStructure;       // TRENDING regime structure validator blocked
        int candlesBlockedByCompressionStructure; // COMPRESSION regime structure validator blocked
        /** How many candles fell into each neutral-reason bucket. */
        Map<String, Integer> neutralReasonCounts = new LinkedHashMap<>();
    }
}
