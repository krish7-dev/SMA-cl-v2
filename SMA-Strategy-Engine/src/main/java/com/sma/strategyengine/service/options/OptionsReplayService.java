package com.sma.strategyengine.service.options;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.model.response.OptionsReplayCandleEvent;
import com.sma.strategyengine.service.MarketRegimeDetector;
import com.sma.strategyengine.strategy.StrategyRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Orchestrates the NIFTY-driven options replay.
 *
 * Flow:
 *   1. Fetch warmup NIFTY candles
 *   2. Fetch replay NIFTY candles
 *   3. Pre-compute regimes for all NIFTY candles
 *   4. Pre-fetch all CE/PE option candles into lookup maps
 *   5. Warm up NiftyDecisionEngine with warmup candles
 *   6. Per replay candle:
 *      a. NiftyDecisionEngine.evaluate -> NiftyDecisionResult
 *      b. OptionExecutionEngine.process -> action
 *      c. Emit OptionsReplayCandleEvent via SSE
 *   7. Force-close any open position (END_OF_REPLAY)
 *   8. Emit final summary event
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OptionsReplayService {

    private final StrategyRegistry  strategyRegistry;
    private final DataEngineClient  dataEngineClient;
    private final ObjectMapper      objectMapper;

    public void run(OptionsReplayRequest req, SseEmitter emitter) {
        try {
            doRun(req, emitter);
        } catch (Exception e) {
            log.error("Options replay failed: {}", e.getMessage(), e);
            try { emitter.completeWithError(e); } catch (Exception ignored) {}
        }
    }

    private void doRun(OptionsReplayRequest req, SseEmitter emitter) throws Exception {

        log.info("Options replay start: NIFTY/{} {} -> {} warmup={}d",
                req.getInterval(), req.getFromDate(), req.getToDate(), req.getWarmupDays());

        // ── 1. Compute warmup start date ──────────────────────────────────────
        LocalDateTime warmupFrom = req.getFromDate().minusDays(req.getWarmupDays());

        // ── 2. Fetch NIFTY candles (warmup + replay) ─────────────────────────
        List<CandleDto> allNiftyCandles = dataEngineClient.fetchHistory(
                new DataEngineClient.HistoryRequest(
                        req.getUserId(), req.getBrokerName(),
                        req.getNiftyInstrumentToken(), req.getNiftySymbol(), req.getNiftyExchange(),
                        req.getInterval(), warmupFrom, req.getToDate(), req.isPersist()));

        if (allNiftyCandles.isEmpty()) {
            emitter.send(SseEmitter.event().name("error").data("No NIFTY candles found"));
            emitter.complete();
            return;
        }

        // Split into warmup and replay sets
        List<CandleDto> warmupCandles = allNiftyCandles.stream()
                .filter(c -> c.openTime() != null && c.openTime().isBefore(req.getFromDate()))
                .collect(Collectors.toList());
        List<CandleDto> replayCandles = allNiftyCandles.stream()
                .filter(c -> c.openTime() != null && !c.openTime().isBefore(req.getFromDate()))
                .collect(Collectors.toList());

        log.info("NIFTY candles: {} warmup + {} replay", warmupCandles.size(), replayCandles.size());

        if (replayCandles.isEmpty()) {
            String msg = String.format(
                    "No replay candles found for %s/%s between %s and %s — " +
                    "all %d fetched candles fall before fromDate. " +
                    "Check that fromDate is a past trading day with available data.",
                    req.getNiftySymbol(), req.getInterval(),
                    req.getFromDate(), req.getToDate(), allNiftyCandles.size());
            log.warn(msg);
            emitter.send(SseEmitter.event().name("error").data(msg));
            emitter.complete();
            return;
        }

        // ── 3. Pre-compute regimes for replay candles ─────────────────────────
        String[] regimes = new String[replayCandles.size()];
        if (req.getRegimeConfig() != null && req.getRegimeConfig().isEnabled()
                && !replayCandles.isEmpty()) {
            BacktestRequest.RegimeConfig rc = req.getRegimeConfig();
            double[] H = toDoubleArray(replayCandles, "high");
            double[] L = toDoubleArray(replayCandles, "low");
            double[] C = toDoubleArray(replayCandles, "close");
            MarketRegimeDetector.Regime[] rawRegimes = MarketRegimeDetector.computeAll(
                    H, L, C, rc.getAdxPeriod(), rc.getAtrPeriod(),
                    rc.getAdxTrendThreshold(), rc.getAtrVolatilePct(), rc.getAtrCompressionPct());
            for (int i = 0; i < rawRegimes.length; i++) {
                regimes[i] = rawRegimes[i] != null ? rawRegimes[i].name() : "RANGING";
            }
        } else {
            Arrays.fill(regimes, "RANGING");
        }

        // ── 4. Pre-fetch option candles ───────────────────────────────────────
        Map<Long, Map<LocalDateTime, CandleDto>> optionCandleMap = new HashMap<>();
        List<OptionsReplayRequest.OptionCandidate> allOptions = new ArrayList<>();
        if (req.getCeOptions() != null) allOptions.addAll(req.getCeOptions());
        if (req.getPeOptions() != null) allOptions.addAll(req.getPeOptions());

        for (OptionsReplayRequest.OptionCandidate opt : allOptions) {
            if (opt.getInstrumentToken() == null) continue;
            try {
                List<CandleDto> optCandles = dataEngineClient.fetchHistory(
                        new DataEngineClient.HistoryRequest(
                                req.getUserId(), req.getBrokerName(),
                                opt.getInstrumentToken(), opt.getTradingSymbol(), opt.getExchange(),
                                req.getInterval(), req.getFromDate(), req.getToDate(), req.isPersist()));
                Map<LocalDateTime, CandleDto> byTime = optCandles.stream()
                        .filter(c -> c.openTime() != null)
                        .collect(Collectors.toMap(CandleDto::openTime, c -> c, (a, b) -> a));
                optionCandleMap.put(opt.getInstrumentToken(), byTime);
                log.info("Loaded {} candles for option {}", optCandles.size(), opt.getTradingSymbol());
            } catch (Exception e) {
                log.warn("Failed to fetch candles for option {}: {}", opt.getTradingSymbol(), e.getMessage());
                optionCandleMap.put(opt.getInstrumentToken(), Map.of());
            }
        }

        // ── 5. Initialise engines ─────────────────────────────────────────────
        OptionsReplayRequest.DecisionConfig dc = Optional.ofNullable(req.getDecisionConfig())
                .orElse(new OptionsReplayRequest.DecisionConfig());
        OptionsReplayRequest.SwitchConfig sc = Optional.ofNullable(req.getSwitchConfig())
                .orElse(new OptionsReplayRequest.SwitchConfig());
        OptionsReplayRequest.SelectionConfig sel = Optional.ofNullable(req.getSelectionConfig())
                .orElse(new OptionsReplayRequest.SelectionConfig());

        OptionsReplayRequest.RegimeRules rr = Optional.ofNullable(req.getRegimeRules())
                .orElse(new OptionsReplayRequest.RegimeRules());
        OptionsReplayRequest.RegimeStrategyRules rsr = Optional.ofNullable(req.getRegimeStrategyRules())
                .orElse(new OptionsReplayRequest.RegimeStrategyRules());
        OptionsReplayRequest.ChopRules cr = Optional.ofNullable(req.getChopRules())
                .orElse(new OptionsReplayRequest.ChopRules());
        OptionsReplayRequest.RangeQualityConfig rqc = Optional.ofNullable(req.getRangeQualityConfig())
                .orElse(new OptionsReplayRequest.RangeQualityConfig());
        OptionsReplayRequest.TradeQualityConfig tqc = Optional.ofNullable(req.getTradeQualityConfig())
                .orElse(new OptionsReplayRequest.TradeQualityConfig());
        OptionsReplayRequest.TrendEntryConfig tec = Optional.ofNullable(req.getTrendEntryConfig())
                .orElse(new OptionsReplayRequest.TrendEntryConfig());
        OptionsReplayRequest.CompressionEntryConfig cec = Optional.ofNullable(req.getCompressionEntryConfig())
                .orElse(new OptionsReplayRequest.CompressionEntryConfig());
        NiftyDecisionEngine  decisionEngine  = new NiftyDecisionEngine(strategyRegistry, req.getStrategies(), dc, sc, rr, rsr, cr, rqc, tqc, tec, cec);
        OptionSelectorService selectorService = new OptionSelectorService(sel, optionCandleMap);
        OptionExecutionEngine execEngine      = new OptionExecutionEngine(req);

        // Emit init event
        emitter.send(SseEmitter.event().name("init")
                .data(Map.of("totalCandles", replayCandles.size(),
                             "warmupCandles", warmupCandles.size())));

        // Warm up NiftyDecisionEngine with pre-replay candles
        decisionEngine.warmup(warmupCandles);

        // ── 6. Replay loop ────────────────────────────────────────────────────
        List<OptionsReplayRequest.OptionCandidate> cePool =
                req.getCeOptions() != null ? req.getCeOptions() : List.of();
        List<OptionsReplayRequest.OptionCandidate> pePool =
                req.getPeOptions() != null ? req.getPeOptions() : List.of();

        int total = replayCandles.size();
        for (int i = 0; i < total; i++) {
            CandleDto       niftyCandle = replayCandles.get(i);
            String          regime      = regimes[i];
            LocalDateTime   candleTime  = niftyCandle.openTime();

            // a. Decision
            NiftyDecisionResult decision = decisionEngine.evaluate(niftyCandle, regime);

            // Apply trading rules (post-process: override entryAllowed / blockReason)
            applyTradingRules(decision, regime, req.getTradingRules());

            // Apply score-tier rules (block WEAK trades after loss or in RANGING)
            applyScoreTierRules(decision, regime, tqc, execEngine.getBarsSinceLastLoss());

            // b. Execution
            double niftyClose = niftyCandle.close().doubleValue();
            String action = execEngine.process(decision, selectorService, cePool, pePool,
                    niftyClose, candleTime);

            // c. Build and emit event
            OptionsReplayCandleEvent event = buildEvent(i + 1, total, niftyCandle, decision,
                    execEngine, selectorService, candleTime, action);

            emitter.send(SseEmitter.event().name("candle").data(objectMapper.writeValueAsString(event)));

            // Speed control
            if (req.getSpeedMultiplier() > 0 && req.getSpeedMultiplier() < 1000) {
                long delayMs = Math.max(0, 1000L / req.getSpeedMultiplier());
                if (delayMs > 0) Thread.sleep(delayMs);
            }
        }

        // ── 7. Force-close open position at end ───────────────────────────────
        if (execEngine.getState() != OptionExecutionEngine.PositionState.FLAT
                && !replayCandles.isEmpty()) {
            LocalDateTime lastTime = replayCandles.get(replayCandles.size() - 1).openTime();
            String forceAction = execEngine.forceClose(selectorService, lastTime);
            log.info("Force-closed position at end of replay: {}", forceAction);
        }

        // ── 8. Summary event ──────────────────────────────────────────────────
        Map<String, Object> summary = new HashMap<>();
        summary.put("totalTrades",  execEngine.getClosedTrades().size());
        summary.put("realizedPnl",  execEngine.getRealizedPnl());
        summary.put("finalCapital", execEngine.getCapital());
        summary.put("closedTrades", execEngine.getClosedTrades());
        summary.put("diagnostics",  decisionEngine.getDiagnostics());
        emitter.send(SseEmitter.event().name("summary").data(objectMapper.writeValueAsString(summary)));

        decisionEngine.cleanup();
        emitter.complete();
        log.info("Options replay complete: {} candles, {} trades, pnl={}",
                total, execEngine.getClosedTrades().size(), execEngine.getRealizedPnl());
    }

    // ── Score tier rules ──────────────────────────────────────────────────────

    private void applyScoreTierRules(NiftyDecisionResult decision,
                                     String regime,
                                     OptionsReplayRequest.TradeQualityConfig tqc,
                                     int barsSinceLastLoss) {
        if (tqc == null || !tqc.isEnabled()) return;
        if (!decision.isEntryAllowed()) return; // already blocked — don't overwrite

        String strength = decision.getTradeStrength();
        if (!"WEAK".equals(strength)) return; // STRONG / NORMAL always pass

        // Block WEAK trades within loss cooldown window
        if (tqc.getWeakTradeLossCooldown() > 0
                && barsSinceLastLoss < tqc.getWeakTradeLossCooldown()) {
            decision.setEntryAllowed(false);
            decision.setBlockReason("WEAK trade blocked: barsSinceLastLoss=" + barsSinceLastLoss
                    + " < cooldown=" + tqc.getWeakTradeLossCooldown());
            decision.setTradeStrength("NONE");
            return;
        }

        // Block WEAK trades in RANGING regime
        if (tqc.isBlockWeakInRanging() && "RANGING".equals(regime)) {
            decision.setEntryAllowed(false);
            decision.setBlockReason("WEAK trade blocked in RANGING regime");
            decision.setTradeStrength("NONE");
        }
    }

    // ── Trading rules ─────────────────────────────────────────────────────────

    private void applyTradingRules(NiftyDecisionResult decision,
                                   String regime,
                                   OptionsReplayRequest.TradingRules rules) {
        if (rules == null || !rules.isEnabled()) return;
        if (!decision.isEntryAllowed()) return; // already blocked — don't overwrite

        if (rules.isRangingNoTrade() && "RANGING".equals(regime)) {
            decision.setEntryAllowed(false);
            decision.setBlockReason("trading rule: no trade in RANGING");
            return;
        }
        if (rules.isVolatileNoTrade() && "VOLATILE".equals(regime)) {
            decision.setEntryAllowed(false);
            decision.setBlockReason("trading rule: no trade in VOLATILE");
            return;
        }
    }

    // ── Event builder ─────────────────────────────────────────────────────────

    private OptionsReplayCandleEvent buildEvent(int emitted, int total,
            CandleDto nifty, NiftyDecisionResult decision,
            OptionExecutionEngine exec, OptionSelectorService selector,
            LocalDateTime candleTime, String action) {

        // Option candle for active instrument
        CandleDto optCandle = exec.getActiveToken() != null
                ? selector.getCandle(exec.getActiveToken(), candleTime) : null;

        return OptionsReplayCandleEvent.builder()
                .emitted(emitted).total(total)
                // NIFTY candle
                .niftyTime(nifty.openTime() != null ? nifty.openTime().toString() : null)
                .niftyOpen(nifty.open().doubleValue())
                .niftyHigh(nifty.high().doubleValue())
                .niftyLow(nifty.low().doubleValue())
                .niftyClose(nifty.close().doubleValue())
                .niftyVolume(nifty.volume() != null ? nifty.volume() : 0L)
                // Decision
                .niftyBias(decision.getRawBias() != null ? decision.getRawBias().name() : "NEUTRAL")
                .previousNiftyBias(decision.getPreviousBias() != null ? decision.getPreviousBias().name() : "NEUTRAL")
                .confirmedBias(decision.getConfirmedBias() != null ? decision.getConfirmedBias().name() : "NEUTRAL")
                .winnerStrategy(decision.getWinnerStrategy())
                .winnerScore(decision.getWinnerScore())
                .scoreGap(decision.getScoreGap())
                .confidenceLevel(decision.getConfidenceLevel())
                .regime(decision.getRegime())
                .recentMove3(decision.getRecentMove3())
                .recentMove5(decision.getRecentMove5())
                .distanceFromVwap(decision.getDistanceFromVwap())
                .barsSinceLastTrade(exec.getBarsSinceLastTrade())
                .entryAllowed(decision.isEntryAllowed())
                .blockReason(decision.getBlockReason())
                .penalizedScore(decision.getPenalizedScore())
                .tradeStrength(decision.getTradeStrength())
                .neutralReason(decision.getNeutralReason())
                .effectiveMinScore(decision.getEffectiveMinScore())
                .effectiveMinScoreGap(decision.getEffectiveMinScoreGap())
                .secondStrategy(decision.getSecondStrategy())
                .secondScore(decision.getSecondScore())
                .shadowWinner(decision.getShadowWinner())
                .shadowWinnerScore(decision.getShadowWinnerScore())
                .shadowWinnerReasonNotTaken(decision.getShadowWinnerReasonNotTaken())
                .switchRequested(decision.isSwitchRequested())
                .switchConfirmed(decision.isSwitchConfirmed())
                .switchReason(decision.getSwitchReason())
                .switchCountToday(decision.getSwitchCountToday())
                .candidates(toCandidateEvents(decision.getCandidates()))
                // Execution
                .positionState(exec.getState().name())
                .desiredSide(exec.getDesiredSide().name())
                .action(action)
                .exitReason(exec.getLastExitReason())
                .entryRegime(exec.getEntryRegime())
                .appliedMinHold(exec.getAppliedMinHold())
                .holdActive(exec.isHoldActive())
                .selectedToken(exec.getActiveToken())
                .selectedOptionType(exec.getActiveOptionType())
                .selectedStrike(exec.getActiveStrike())
                .selectedExpiry(exec.getActiveExpiry())
                .selectedTradingSymbol(exec.getActiveTradingSymbol())
                .entryPrice(exec.getEntryPrice())
                .barsInTrade(exec.getBarsInTrade())
                .unrealizedPnl(exec.getUnrealizedPnl())
                .realizedPnl(exec.getRealizedPnl())
                .totalPnl(exec.getRealizedPnl() + exec.getUnrealizedPnl())
                .capital(exec.getCapital())
                // Option candle
                .optionTime(optCandle != null && optCandle.openTime() != null
                        ? optCandle.openTime().toString() : null)
                .optionOpen(optCandle != null && optCandle.open() != null
                        ? optCandle.open().doubleValue() : null)
                .optionHigh(optCandle != null && optCandle.high() != null
                        ? optCandle.high().doubleValue() : null)
                .optionLow(optCandle != null && optCandle.low() != null
                        ? optCandle.low().doubleValue() : null)
                .optionClose(optCandle != null && optCandle.close() != null
                        ? optCandle.close().doubleValue() : null)
                .optionVolume(optCandle != null ? optCandle.volume() : null)
                // Closed trades
                .closedTrades(new ArrayList<>(exec.getClosedTrades()))
                .build();
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    private double[] toDoubleArray(List<CandleDto> candles, String field) {
        return candles.stream().mapToDouble(c -> switch (field) {
            case "high"  -> c.high().doubleValue();
            case "low"   -> c.low().doubleValue();
            default      -> c.close().doubleValue();
        }).toArray();
    }

    private List<OptionsReplayCandleEvent.CandidateScore> toCandidateEvents(
            List<NiftyDecisionResult.CandidateScore> src) {
        if (src == null) return List.of();
        return src.stream().map(c -> OptionsReplayCandleEvent.CandidateScore.builder()
                .strategyType(c.getStrategyType())
                .signal(c.getSignal())
                .baseScore(c.getBaseScore())
                .trendComponent(c.getTrendComponent())
                .volatilityComponent(c.getVolatilityComponent())
                .momentumComponent(c.getMomentumComponent())
                .confidenceComponent(c.getConfidenceComponent())
                .penaltyReversal(c.getPenaltyReversal())
                .penaltyOverextension(c.getPenaltyOverextension())
                .penaltySameColor(c.getPenaltySameColor())
                .penaltyMismatch(c.getPenaltyMismatch())
                .penaltyVolatileOption(c.getPenaltyVolatileOption())
                .totalPenalty(c.getTotalPenalty())
                .score(c.getScore())
                .eligible(c.isEligible())
                .eligibilityReason(c.getEligibilityReason())
                // Legacy aliases
                .trendStrength(c.getTrendStrength())
                .volatility(c.getVolatility())
                .momentum(c.getMomentum())
                .confidence(c.getConfidence())
                .penalty(c.getPenalty())
                .build()).collect(Collectors.toList());
    }
}
