package com.sma.strategyengine.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.client.DataEngineClient.HistoryRequest;
import com.sma.strategyengine.model.request.BacktestRequest.PatternConfig;
import com.sma.strategyengine.model.request.BacktestRequest.RegimeConfig;
import com.sma.strategyengine.model.request.BacktestRequest.RiskConfig;
import com.sma.strategyengine.model.request.BacktestRequest.ScoreConfig;
import com.sma.strategyengine.model.request.BacktestRequest.StrategyConfig;
import com.sma.strategyengine.model.request.ReplayRequest;
import com.sma.strategyengine.model.request.ReplayRequest.EntryFilterConfig;
import com.sma.strategyengine.model.request.ReplayRequest.RulesConfig;
import com.sma.strategyengine.model.request.ReplayRequest.RulesConfig.OptionRules;
import com.sma.strategyengine.model.request.ReplayRequest.RulesConfig.StockRules;
import com.sma.strategyengine.model.request.ReplayRequest.RulesConfig.StockRules.LongQualityGate;
import com.sma.strategyengine.model.response.ReplayCandleEvent;
import com.sma.strategyengine.model.response.ReplayCandleEvent.*;
import com.sma.strategyengine.strategy.PositionDirection;
import com.sma.strategyengine.strategy.StrategyContext;
import com.sma.strategyengine.strategy.StrategyLogic;
import com.sma.strategyengine.strategy.StrategyRegistry;
import com.sma.strategyengine.strategy.StrategyResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;

/**
 * Core streaming replay evaluation service.
 *
 * <p>Fetches historical candles from Data Engine (including warmup days),
 * runs full strategy evaluation per-candle (regime, scoring, trading rules,
 * pattern confirmation, position management), and streams enriched
 * {@link ReplayCandleEvent} objects back to the caller via SSE.
 *
 * <h3>Evaluation loop per candle:</h3>
 * <ol>
 *   <li>Detect regime (incremental — no full pre-computation needed)</li>
 *   <li>Tick down cooldowns and reversal cooldowns</li>
 *   <li>SL/TP check for all open individual positions</li>
 *   <li>SL/TP check for combined pool position</li>
 *   <li>Daily loss cap check</li>
 *   <li>Generate signal from each strategy logic</li>
 *   <li>Apply OPTION rules (disable SMA/BREAKOUT, volatile block)</li>
 *   <li>Apply regime-based rules</li>
 *   <li>Apply pattern confirmation</li>
 *   <li>BUY: if already LONG → blocked; if SHORT → close+reverse; else long gate check → open LONG</li>
 *   <li>SELL: if already SHORT → blocked; if LONG → close + open SHORT; else blocked if no shorting</li>
 *   <li>Combined pool: score all strategies, pick best, apply same rules</li>
 *   <li>Emit SSE event with full state snapshot</li>
 *   <li>Sleep according to speedMultiplier</li>
 * </ol>
 *
 * <p>The Combined pool label matches the frontend constant: {@value #COMBINED_LABEL}.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ReplayEvalService {

    public static final String COMBINED_LABEL = "\u26a1 Combined";

    private static final DateTimeFormatter DT_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm");

    private final DataEngineClient   dataEngineClient;
    private final StrategyRegistry   strategyRegistry;
    private final ObjectMapper       objectMapper;

    // ─── Interval → milliseconds (for speed-controlled sleep) ────────────────

    private static final Map<String, Long> INTERVAL_MS = Map.of(
            "MINUTE_1",  60_000L,
            "MINUTE_3",  180_000L,
            "MINUTE_5",  300_000L,
            "MINUTE_10", 600_000L,
            "MINUTE_15", 900_000L,
            "MINUTE_30", 1_800_000L,
            "MINUTE_60", 3_600_000L,
            "DAY",       86_400_000L,
            "WEEK",      604_800_000L,
            "MONTH",     2_592_000_000L
    );

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Runs the full replay evaluation and streams events into {@code emitter}.
     * Intended to be called from a background executor thread.
     *
     * @param req     validated replay request
     * @param emitter SSE emitter to write events into; completed/errored when done
     */
    public void run(ReplayRequest req, SseEmitter emitter) {
        try {
            runInternal(req, emitter);
            emitter.complete();
        } catch (Exception e) {
            log.error("Replay evaluation failed: {}", e.getMessage(), e);
            try { emitter.completeWithError(e); } catch (Exception ignored) {}
        }
    }

    // ─── Internal evaluation ──────────────────────────────────────────────────

    private void runInternal(ReplayRequest req, SseEmitter emitter) throws Exception {

        // ── Resolve config references ──────────────────────────────────────
        RiskConfig    riskCfg    = req.getRiskConfig();
        PatternConfig patCfg     = req.getPatternConfig();
        RegimeConfig  regimeCfg  = req.getRegimeConfig();
        ScoreConfig   scoreCfg   = req.getScoreConfig();
        RulesConfig   rulesCfg   = req.getRulesConfig() != null ? req.getRulesConfig() : new RulesConfig();

        boolean riskOn    = riskCfg  != null && riskCfg.isEnabled();
        boolean patternOn = patCfg   != null && patCfg.isEnabled();
        boolean regimeOn  = regimeCfg != null && regimeCfg.isEnabled();
        boolean scoreOn          = scoreCfg  != null && scoreCfg.isEnabled();
        boolean rulesOn          = rulesCfg.isEnabled();
        boolean combinedOnlyMode = req.isCombinedOnlyMode() && scoreOn;

        String instrType = req.getInstrumentType() != null ? req.getInstrumentType().toUpperCase() : "STOCK";
        boolean isOption = "OPTION".equals(instrType);

        double minScore = scoreCfg != null ? scoreCfg.getMinScoreThreshold() : 30.0;

        StockRules   stockRules  = rulesCfg.getStocks()  != null ? rulesCfg.getStocks()  : new StockRules();
        OptionRules  optionRules = rulesCfg.getOptions() != null ? rulesCfg.getOptions() : new OptionRules();

        EntryFilterConfig efCfg     = req.getEntryFilterConfig() != null ? req.getEntryFilterConfig() : new EntryFilterConfig();
        boolean           efEnabled = efCfg.isEnabled();

        // ── Risk fractions ────────────────────────────────────────────────
        BigDecimal slFrac   = fracOrNull(riskCfg == null ? null : riskCfg.getStopLossPct());
        BigDecimal tpFrac   = fracOrNull(riskCfg == null ? null : riskCfg.getTakeProfitPct());
        BigDecimal riskFrac = (riskOn && slFrac != null) ? fracOrNull(riskCfg.getMaxRiskPerTradePct()) : null;
        BigDecimal capFrac  = fracOrNull(riskCfg == null ? null : riskCfg.getDailyLossCapPct());

        List<StrategyConfig> stratCfgs = req.getStrategies();

        // ── Resolve quantity ──────────────────────────────────────────────
        // We use first replay candle for auto-qty; determined after fetch
        int requestedQty = req.getQuantity();

        // ── Fetch warmup + replay candles ─────────────────────────────────
        LocalDateTime replayFrom = req.getFromDate();
        LocalDateTime replayTo   = req.getToDate();

        int    preloadDays     = Math.max(0, req.getPreloadDaysBack());
        String preloadInterval = req.getPreloadInterval() != null && !req.getPreloadInterval().isBlank()
                ? req.getPreloadInterval() : req.getInterval();

        LocalDateTime warmupFrom = replayFrom.minusDays(preloadDays + 7L); // +7 to account for weekends
        warmupFrom = warmupFrom.withHour(9).withMinute(15).withSecond(0);

        List<CandleDto> warmupCandles = List.of();
        if (preloadDays > 0) {
            try {
                warmupCandles = dataEngineClient.fetchHistory(new HistoryRequest(
                        req.getUserId(), req.getBrokerName(), req.getInstrumentToken(),
                        req.getSymbol().toUpperCase(), req.getExchange().toUpperCase(),
                        preloadInterval, warmupFrom, replayFrom, true));
                log.info("Replay warmup: {} candle(s) fetched [{} to {}]",
                        warmupCandles.size(), warmupFrom, replayFrom);
            } catch (Exception e) {
                log.warn("Replay warmup fetch failed (non-fatal): {}", e.getMessage());
            }
        }

        List<CandleDto> replayCandles = dataEngineClient.fetchHistory(new HistoryRequest(
                req.getUserId(), req.getBrokerName(), req.getInstrumentToken(),
                req.getSymbol().toUpperCase(), req.getExchange().toUpperCase(),
                req.getInterval(), replayFrom, replayTo, true));

        if (replayCandles.isEmpty()) {
            throw new IllegalStateException(
                    "No candle data returned for " + req.getSymbol() + " [" + req.getInterval() + "] "
                    + replayFrom + " to " + replayTo);
        }

        log.info("Replay eval: {} warmup + {} replay candles, {} strategy config(s)",
                warmupCandles.size(), replayCandles.size(), stratCfgs.size());

        // ── Resolve per-trade quantity ────────────────────────────────────
        final int resolvedQty;
        if (requestedQty > 0) {
            resolvedQty = requestedQty;
        } else {
            BigDecimal firstClose = replayCandles.get(0).close();
            if (firstClose != null && firstClose.compareTo(BigDecimal.ZERO) > 0) {
                int autoQty = req.getInitialCapital().divide(firstClose, 0, RoundingMode.FLOOR).intValue();
                resolvedQty = Math.max(1, autoQty);
            } else {
                resolvedQty = 1;
            }
        }

        // ── Pre-compute regime for all candles (warmup + replay together) ─
        //    We include warmup candles in the input so regime indicators warm up too.
        List<CandleDto> allCandles = new ArrayList<>(warmupCandles.size() + replayCandles.size());
        allCandles.addAll(warmupCandles);
        allCandles.addAll(replayCandles);

        String[] regimeArr = null;
        if (regimeOn) {
            int sz = allCandles.size();
            double[] H = new double[sz], L = new double[sz], C = new double[sz];
            for (int i = 0; i < sz; i++) {
                CandleDto cd = allCandles.get(i);
                H[i] = dbl(cd.high());
                L[i] = dbl(cd.low());
                C[i] = dbl(cd.close());
            }
            MarketRegimeDetector.Regime[] regimes = MarketRegimeDetector.computeAll(
                    H, L, C,
                    regimeCfg.getAdxPeriod(), regimeCfg.getAtrPeriod(),
                    regimeCfg.getAdxTrendThreshold(),
                    regimeCfg.getAtrVolatilePct(), regimeCfg.getAtrCompressionPct());
            regimeArr = new String[sz];
            for (int i = 0; i < sz; i++) {
                regimeArr[i] = regimes[i] != null ? regimes[i].name() : null;
            }
        }

        // ── Initialise per-strategy state ─────────────────────────────────

        // Per-strategy instance IDs (one per config, isolated state)
        Map<String, String>      instanceIds  = new LinkedHashMap<>();
        Map<String, StrategyLogic> logicMap   = new LinkedHashMap<>();
        Map<String, Map<String, String>> paramsMap = new LinkedHashMap<>();
        Map<String, StrategyScorer>      scorerMap = new LinkedHashMap<>();

        for (StrategyConfig cfg : stratCfgs) {
            String label = resolveLabel(cfg);
            instanceIds.put(label, "RP-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10).toUpperCase());
            logicMap.put(label, strategyRegistry.resolve(cfg.getStrategyType()));
            paramsMap.put(label, cfg.getParameters() != null ? cfg.getParameters() : Map.of());
            scorerMap.put(label, new StrategyScorer());
        }

        // A single shared scorer for the combined pool (all strategies push into it)
        StrategyScorer combinedScorer = new StrategyScorer();

        BigDecimal initCap = req.getInitialCapital();

        // Per-label mutable state
        Map<String, PositionState> positions     = new LinkedHashMap<>();
        Map<String, BigDecimal>    capitals      = new LinkedHashMap<>();
        Map<String, List<ClosedTrade>> trades    = new LinkedHashMap<>();
        Map<String, List<EquityPoint>> equities  = new LinkedHashMap<>();
        Map<String, Integer>     cooldowns       = new LinkedHashMap<>();
        Map<String, Integer>     revCooldowns    = new LinkedHashMap<>();
        Map<String, DailyCapState> dailyCaps     = new LinkedHashMap<>();

        for (StrategyConfig cfg : stratCfgs) {
            String label = resolveLabel(cfg);
            positions.put(label, null);
            capitals.put(label, initCap);
            trades.put(label, new ArrayList<>());
            equities.put(label, new ArrayList<>(List.of(EquityPoint.builder().time("start").capital(initCap.doubleValue()).build())));
            cooldowns.put(label, 0);
            revCooldowns.put(label, 0);
            dailyCaps.put(label, new DailyCapState(null, initCap, false));
        }

        // Combined pool state (if scoreOn)
        PositionState     combinedPos     = null;
        BigDecimal        combinedCapital = initCap;
        List<ClosedTrade> combinedTrades  = new ArrayList<>();
        List<EquityPoint> combinedEquities = new ArrayList<>(
                List.of(EquityPoint.builder().time("start").capital(initCap.doubleValue()).build()));
        int combinedRevCooldown = 0;
        DailyCapState combinedDailyCap = new DailyCapState(null, initCap, false);
        int combinedCandleIndex    = 0;   // incremented each candle (live candles only, not warmup)
        int combinedLastExitCandle = -1;  // candle index when last combined position was closed

        // ── Pattern state ─────────────────────────────────────────────────
        double[] patPrev2 = null;
        double[] patPrev1 = null;
        double   pMinWick = patternOn ? patCfg.getMinWickRatio() : 2.0;
        double   pMaxBody = patternOn ? patCfg.getMaxBodyPct()   : 0.35;
        Set<String> buyConfirm  = patternOn && patCfg.getBuyConfirmPatterns()  != null
                ? new HashSet<>(patCfg.getBuyConfirmPatterns())  : Set.of();
        Set<String> sellConfirm = patternOn && patCfg.getSellConfirmPatterns() != null
                ? new HashSet<>(patCfg.getSellConfirmPatterns()) : Set.of();

        // ── VWAP accumulator (cumulative per-day) ─────────────────────────
        // Used by the LONG quality gate rule.
        // Reset each day; tracks sum(typicalPrice * volume) / sum(volume)
        LocalDate vwapDay      = null;
        double    vwapSumTV    = 0.0;
        double    vwapSumV     = 0.0;

        // ── Speed sleep ───────────────────────────────────────────────────
        double speedMultiplier = req.getSpeedMultiplier() > 0 ? req.getSpeedMultiplier() : 1.0;
        // Fixed base delay: 500ms per candle at speed=1 → divide by multiplier.
        // e.g. speed=1 → 500ms, speed=5 → 100ms, speed=50 → 10ms, speed=500 → 1ms (near-instant)
        long sleepMs = Math.max(1L, (long) (500.0 / speedMultiplier));

        // ── Phase 1: silent warmup ────────────────────────────────────────
        for (int wi = 0; wi < warmupCandles.size(); wi++) {
            CandleDto wc = warmupCandles.get(wi);
            double wO = dbl(wc.open()), wH = dbl(wc.high()), wL = dbl(wc.low()), wC = dbl(wc.close());
            long wV = wc.volume() != null ? wc.volume() : 1L;
            String wRegime = (regimeArr != null) ? regimeArr[wi] : null;

            // Feed scorers
            for (StrategyScorer sc : scorerMap.values()) sc.push(wO, wH, wL, wC);
            combinedScorer.push(wO, wH, wL, wC);

            // Feed strategies (maintains warmup/window state)
            for (StrategyConfig cfg : stratCfgs) {
                String label = resolveLabel(cfg);
                StrategyContext ctx = buildCtx(instanceIds.get(label), cfg, req, 1, PositionDirection.FLAT, false, wc);
                logicMap.get(label).evaluate(ctx); // discard result — warmup only
            }

            // Pattern state
            if (wc.open() != null && wc.high() != null && wc.low() != null && wc.close() != null) {
                CandlePatternDetector.detect(patPrev2, patPrev1, wO, wH, wL, wC, pMinWick, pMaxBody);
                patPrev2 = patPrev1;
                patPrev1 = new double[]{wO, wH, wL, wC};
            }

            // VWAP day reset
            if (wc.openTime() != null) {
                LocalDate day = wc.openTime().toLocalDate();
                if (!day.equals(vwapDay)) { vwapDay = day; vwapSumTV = 0; vwapSumV = 0; }
            }
            double tp = (wH + wL + wC) / 3.0;
            double vol = wV;
            vwapSumTV += tp * vol; vwapSumV += vol;
        }

        // ── Send init event so frontend knows warmup count + total candles ──
        int total   = replayCandles.size();
        int emitted = 0;
        int warmupOffset = warmupCandles.size(); // offset into regimeArr
        {
            String initJson = objectMapper.writeValueAsString(
                    Map.of("warmupCount", warmupCandles.size(), "totalCandles", total));
            emitter.send(SseEmitter.event().name("init").data(initJson));
        }

        for (int ri = 0; ri < replayCandles.size(); ri++) {
            CandleDto candle = replayCandles.get(ri);
            int       ai     = warmupOffset + ri; // index into regimeArr / allCandles

            combinedCandleIndex++;
            int barsSinceLastExit = combinedLastExitCandle < 0 ? Integer.MAX_VALUE
                    : combinedCandleIndex - combinedLastExitCandle;
            PositionState combinedPosBeforeCandle = combinedPos; // to detect exits at end of candle

            double cO = dbl(candle.open()), cH = dbl(candle.high()),
                   cL = dbl(candle.low()),  cC = dbl(candle.close());
            long   cV = candle.volume() != null ? candle.volume() : 1L;
            String candleTime = candle.openTime() != null
                    ? candle.openTime().format(DT_FMT) : "";
            String regime = (regimeArr != null) ? regimeArr[ai] : null;

            // ── Feed scorers ──────────────────────────────────────────────
            for (StrategyScorer sc : scorerMap.values()) sc.push(cO, cH, cL, cC);
            combinedScorer.push(cO, cH, cL, cC);

            // ── Candle pattern detection ───────────────────────────────────
            List<String> detectedPatterns = List.of();
            if (candle.open() != null && candle.high() != null
                    && candle.low() != null && candle.close() != null) {
                detectedPatterns = CandlePatternDetector.detect(
                        patPrev2, patPrev1, cO, cH, cL, cC, pMinWick, pMaxBody);
                patPrev2 = patPrev1;
                patPrev1 = new double[]{cO, cH, cL, cC};
            }
            final List<String> fp = detectedPatterns;
            boolean patOkBuy  = buyConfirm.isEmpty()  || fp.stream().anyMatch(buyConfirm::contains);
            boolean patOkSell = sellConfirm.isEmpty() || fp.stream().anyMatch(sellConfirm::contains);

            // ── VWAP update ───────────────────────────────────────────────
            if (candle.openTime() != null) {
                LocalDate day = candle.openTime().toLocalDate();
                if (!day.equals(vwapDay)) { vwapDay = day; vwapSumTV = 0; vwapSumV = 0; }
            }
            vwapSumTV += ((cH + cL + cC) / 3.0) * cV;
            vwapSumV  += cV;
            double currentVwap        = vwapSumV > 0 ? vwapSumTV / vwapSumV : 0.0;
            Double eventVwap          = currentVwap > 0 ? currentVwap : null;
            Double eventDistVwapPct   = currentVwap > 0 ? ((cC - currentVwap) / currentVwap) * 100.0 : null;

            // ── Day boundary reset for daily cap tracking ──────────────────
            LocalDate candleDay = candle.openTime() != null ? candle.openTime().toLocalDate() : null;
            if (riskOn) {
                for (String label : cooldowns.keySet()) {
                    DailyCapState dc = dailyCaps.get(label);
                    if (candleDay != null && !candleDay.equals(dc.date)) {
                        dailyCaps.put(label, new DailyCapState(candleDay, capitals.get(label), false));
                    }
                }
                if (candleDay != null && !candleDay.equals(combinedDailyCap.date)) {
                    combinedDailyCap = new DailyCapState(candleDay, combinedCapital, false);
                }
            }

            // ── Tick down cooldowns ────────────────────────────────────────
            for (String label : cooldowns.keySet()) {
                int c = cooldowns.get(label); if (c > 0) cooldowns.put(label, c - 1);
                int rc = revCooldowns.get(label); if (rc > 0) revCooldowns.put(label, rc - 1);
            }
            if (combinedRevCooldown > 0) combinedRevCooldown--;

            // ── Lists for this candle ──────────────────────────────────────
            List<ActionEntry>   actions         = new ArrayList<>();
            List<BlockedSignal> blockedSignals  = new ArrayList<>();
            List<CombinedDetail> combinedDetails = new ArrayList<>();
            Map<String, String>  signals         = new LinkedHashMap<>();
            Map<String, String>  candleClosedDir = new HashMap<>();
            String       combinedWinner      = null;
            Double       combinedWinnerScore = null;
            List<String> combinedCandidates  = new ArrayList<>();
            String       combinedBlockReason = null;
            List<String[]> allScoredTuples   = new ArrayList<>();
            List<String> combinedAllScored   = new ArrayList<>();

            // ── SL/TP check for individual positions ──────────────────────
            for (StrategyConfig cfg : stratCfgs) {
                String        label = resolveLabel(cfg);
                PositionState pos   = positions.get(label);
                if (pos == null || !riskOn) continue;

                String exitReason = null;
                double exitPrice  = 0;
                if (pos.type == PositionDirection.LONG) {
                    if (pos.slPrice != null && cL <= pos.slPrice) {
                        exitPrice = pos.slPrice; exitReason = "STOP_LOSS";
                    } else if (pos.tpPrice != null && cH >= pos.tpPrice) {
                        exitPrice = pos.tpPrice; exitReason = "TAKE_PROFIT";
                    }
                } else if (pos.type == PositionDirection.SHORT) {
                    if (pos.slPrice != null && cH >= pos.slPrice) {
                        exitPrice = pos.slPrice; exitReason = "STOP_LOSS";
                    } else if (pos.tpPrice != null && cL <= pos.tpPrice) {
                        exitPrice = pos.tpPrice; exitReason = "TAKE_PROFIT";
                    }
                }
                if (exitReason != null) {
                    ClosedTrade ct = closePosition(label, pos, exitPrice, candleTime, exitReason, regime,
                            capitals, trades, equities);
                    positions.put(label, null);
                    String act = pos.type == PositionDirection.LONG ? "Exit Long" : "Exit Short";
                    String rsn = "STOP_LOSS".equals(exitReason) ? "Stop Loss hit" : "Take Profit hit";
                    actions.add(ActionEntry.builder()
                            .strategyLabel(label).action(act).reason(rsn)
                            .exitReason(exitReason).price(exitPrice).regime(regime).build());
                    if (riskOn && riskCfg.getCooldownCandles() > 0 && ct.getPnl() <= 0) {
                        cooldowns.put(label, riskCfg.getCooldownCandles());
                    }
                }
            }

            // ── SL/TP check for combined position ─────────────────────────
            if (scoreOn && combinedPos != null && riskOn) {
                String exitReason = null;
                double exitPrice  = 0;
                if (combinedPos.type == PositionDirection.LONG) {
                    if (combinedPos.slPrice != null && cL <= combinedPos.slPrice) {
                        exitPrice = combinedPos.slPrice; exitReason = "STOP_LOSS";
                    } else if (combinedPos.tpPrice != null && cH >= combinedPos.tpPrice) {
                        exitPrice = combinedPos.tpPrice; exitReason = "TAKE_PROFIT";
                    }
                } else if (combinedPos.type == PositionDirection.SHORT) {
                    if (combinedPos.slPrice != null && cH >= combinedPos.slPrice) {
                        exitPrice = combinedPos.slPrice; exitReason = "STOP_LOSS";
                    } else if (combinedPos.tpPrice != null && cL <= combinedPos.tpPrice) {
                        exitPrice = combinedPos.tpPrice; exitReason = "TAKE_PROFIT";
                    }
                }
                if (exitReason != null) {
                    PositionState closedCombined = combinedPos;
                    ClosedTrade ct = closePositionDirect(closedCombined, exitPrice, candleTime, exitReason, regime,
                            combinedCapital, combinedTrades, combinedEquities);
                    combinedCapital = BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP);
                    combinedPos = null;
                    String act = closedCombined.type == PositionDirection.LONG ? "Exit Long" : "Exit Short";
                    String rsn = "STOP_LOSS".equals(exitReason) ? "Stop Loss hit" : "Take Profit hit";
                    combinedDetails.add(CombinedDetail.builder()
                            .action(act).reason(rsn).exitReason(exitReason)
                            .price(exitPrice).regime(regime).sourceStrategy(closedCombined.sourceStrategy)
                            .trigger("Risk Management").build());
                }
            }

            // ── Evaluate all strategies ────────────────────────────────────
            for (StrategyConfig cfg : stratCfgs) {
                String label = resolveLabel(cfg);

                // Cooldown check
                if (cooldowns.get(label) > 0) {
                    continue;
                }

                // Daily cap check
                if (riskOn) {
                    DailyCapState dc = dailyCaps.get(label);
                    if (dc.halted) continue;
                    if (capFrac != null && dc.startCapital.compareTo(BigDecimal.ZERO) > 0) {
                        BigDecimal lost = dc.startCapital.subtract(capitals.get(label))
                                .divide(dc.startCapital, 8, RoundingMode.HALF_UP);
                        if (lost.compareTo(capFrac) >= 0) {
                            dailyCaps.put(label, new DailyCapState(dc.date, dc.startCapital, true));
                            continue;
                        }
                    }
                }

                // OPTION rule: disable SMA_CROSSOVER and BREAKOUT
                if (isOption && rulesOn && optionRules.isDisableSmaBreakout()) {
                    String st = cfg.getStrategyType();
                    if ("SMA_CROSSOVER".equals(st) || "BREAKOUT".equals(st)) continue;
                }

                // Regime filter (strategy's activeRegimes)
                if (regimeOn && regime != null && cfg.getActiveRegimes() != null && !cfg.getActiveRegimes().isEmpty()) {
                    if (!cfg.getActiveRegimes().contains(regime)) continue;
                }

                // Generate signal
                PositionState pos = positions.get(label);
                PositionDirection curDir = pos != null ? pos.type : PositionDirection.FLAT;
                boolean allowShorting = isAllowShorting(cfg);
                StrategyContext ctx = buildCtx(instanceIds.get(label), cfg, req, resolvedQty, curDir, allowShorting, candle);
                StrategyResult  sr  = logicMap.get(label).evaluate(ctx);

                String signal = sr.isBuy() ? "BUY" : sr.isSell() ? "SELL" : "HOLD";
                signals.put(label, signal);

                if ("HOLD".equals(signal)) continue;

                // Regime-based rules (stock)
                if (!isOption && rulesOn) {
                    if (stockRules.isRangingNoTrade() && "RANGING".equals(regime)) {
                        blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                .price(cC).reason("Rule: No trade in RANGING regime").build());
                        continue;
                    }
                    if (stockRules.isCompressionShortOnly() && "COMPRESSION".equals(regime) && "BUY".equals(signal)) {
                        blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                .price(cC).reason("Rule: SHORT only in COMPRESSION (BUY blocked)").build());
                        continue;
                    }
                }

                // Regime-based rules (option)
                if (isOption && rulesOn && optionRules.isVolatileNoTrade() && "VOLATILE".equals(regime)) {
                    blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                            .price(cC).reason("Rule: No trade in VOLATILE regime").build());
                    continue;
                }

                // Pattern confirmation
                if (patternOn) {
                    if ("BUY".equals(signal) && !patOkBuy) {
                        blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                .price(cC).reason("Pattern: no BUY confirm").build());
                        continue;
                    }
                    if ("SELL".equals(signal) && !patOkSell) {
                        blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                .price(cC).reason("Pattern: no SELL confirm").build());
                        continue;
                    }
                }

                // In combined-only mode strategies only contribute signals to the combined pool,
                // they don't trade their own capital.
                if (combinedOnlyMode) continue;

                boolean hasLong  = pos != null && pos.type == PositionDirection.LONG;
                boolean hasShort = pos != null && pos.type == PositionDirection.SHORT;
                boolean noSameCandleRev = rulesOn && (isOption
                        ? optionRules.isNoSameCandleReversal()
                        : stockRules.isNoSameCandleReversal());

                StrategyScorer.ScoreResult scoreForGate = scorerMap.get(label)
                        .score(cfg.getStrategyType(), "BUY".equals(signal), regime, instrType);

                if ("BUY".equals(signal)) {
                    if (hasLong) {
                        blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                .price(cC).reason("Already in LONG position").build());
                    } else if (hasShort) {
                        if (noSameCandleRev && "SHORT".equals(candleClosedDir.get(label))) {
                            blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                    .price(cC).reason("Rule: No same-candle reversal (SHORT already closed)").build());
                            continue;
                        }
                        // Close short, then optionally open long
                        ClosedTrade ct = closePosition(label, pos, cC, candleTime, "SIGNAL", regime,
                                capitals, trades, equities);
                        positions.put(label, null);
                        actions.add(ActionEntry.builder().strategyLabel(label).action("Exit Short")
                                .reason("Signal").exitReason("SIGNAL").price(cC).regime(regime).build());
                        candleClosedDir.put(label, "SHORT");
                        if (riskOn && riskCfg.getCooldownCandles() > 0 && ct.getPnl() <= 0) {
                            cooldowns.put(label, riskCfg.getCooldownCandles());
                        }
                        if (allowShorting) {
                            String gateBlock = longGateBlock(label, cC, regime, instrType, scoreForGate,
                                    revCooldowns.get(label), currentVwap, rulesOn, stockRules, isOption);
                            if (gateBlock == null) {
                                int qty = sizeQty(resolvedQty, capitals.get(label), cC, riskFrac, slFrac);
                                PositionState newPos = openPosition(label, PositionDirection.LONG, cC, qty,
                                        candleTime, regime, null, slFrac, tpFrac, positions, capitals);
                                revCooldowns.put(label, 2);
                                actions.add(ActionEntry.builder().strategyLabel(label).action("Enter Long")
                                        .reason("Reversal SHORT->LONG").price(cC).regime(regime).build());
                            } else {
                                blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                        .price(cC).reason(gateBlock).build());
                            }
                        }
                    } else {
                        // Flat — enter long
                        String gateBlock = longGateBlock(label, cC, regime, instrType, scoreForGate,
                                revCooldowns.get(label), currentVwap, rulesOn, stockRules, isOption);
                        if (gateBlock == null) {
                            int qty = sizeQty(resolvedQty, capitals.get(label), cC, riskFrac, slFrac);
                            openPosition(label, PositionDirection.LONG, cC, qty,
                                    candleTime, regime, null, slFrac, tpFrac, positions, capitals);
                            actions.add(ActionEntry.builder().strategyLabel(label).action("Enter Long")
                                    .reason("Signal").price(cC).regime(regime).build());
                        } else {
                            blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                    .price(cC).reason(gateBlock).build());
                        }
                    }
                } else { // SELL
                    if (hasShort) {
                        blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                .price(cC).reason("Already in SHORT position").build());
                    } else if (hasLong) {
                        if (noSameCandleRev && "LONG".equals(candleClosedDir.get(label))) {
                            blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                    .price(cC).reason("Rule: No same-candle reversal (LONG already closed)").build());
                            continue;
                        }
                        ClosedTrade ct = closePosition(label, pos, cC, candleTime, "SIGNAL", regime,
                                capitals, trades, equities);
                        positions.put(label, null);
                        actions.add(ActionEntry.builder().strategyLabel(label).action("Exit Long")
                                .reason("Signal").exitReason("SIGNAL").price(cC).regime(regime).build());
                        candleClosedDir.put(label, "LONG");
                        if (riskOn && riskCfg.getCooldownCandles() > 0 && ct.getPnl() <= 0) {
                            cooldowns.put(label, riskCfg.getCooldownCandles());
                        }
                        if (allowShorting) {
                            int qty = sizeQty(resolvedQty, capitals.get(label), cC, riskFrac, slFrac);
                            openPosition(label, PositionDirection.SHORT, cC, qty,
                                    candleTime, regime, null, slFrac, tpFrac, positions, capitals);
                            revCooldowns.put(label, 2);
                            actions.add(ActionEntry.builder().strategyLabel(label).action("Enter Short")
                                    .reason("Reversal LONG->SHORT").price(cC).regime(regime).build());
                        }
                    } else {
                        // Flat
                        if (allowShorting) {
                            int qty = sizeQty(resolvedQty, capitals.get(label), cC, riskFrac, slFrac);
                            openPosition(label, PositionDirection.SHORT, cC, qty,
                                    candleTime, regime, null, slFrac, tpFrac, positions, capitals);
                            actions.add(ActionEntry.builder().strategyLabel(label).action("Enter Short")
                                    .reason("Signal").price(cC).regime(regime).build());
                        } else {
                            blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                    .price(cC).reason("Shorting disabled — no open LONG to exit").build());
                        }
                    }
                }
            } // end per-strategy loop

            // ── Combined pool ──────────────────────────────────────────────
            if (scoreOn) {
                // Global regime block for combined pool
                boolean combinedBlocked = rulesOn && (
                        (!isOption && stockRules.isRangingNoTrade()       && "RANGING".equals(regime)) ||
                        (isOption  && optionRules.isVolatileNoTrade()     && "VOLATILE".equals(regime))
                );
                if (combinedBlocked) {
                    combinedBlockReason = !isOption ? "RANGING regime — no-trade rule"
                                                    : "VOLATILE regime — no-trade rule";
                }

                String bestLabel   = null;
                String bestSignal  = null;
                StrategyScorer.ScoreResult bestScore = null;

                if (!combinedBlocked) {
                    for (StrategyConfig cfg : stratCfgs) {
                        String lbl = resolveLabel(cfg);

                        // OPTION: disable SMA/BREAKOUT in scoring
                        if (isOption && rulesOn && optionRules.isDisableSmaBreakout()) {
                            String st = cfg.getStrategyType();
                            if ("SMA_CROSSOVER".equals(st) || "BREAKOUT".equals(st)) continue;
                        }

                        // STOCK COMPRESSION: skip BUY signals
                        if (!isOption && rulesOn && stockRules.isCompressionShortOnly()
                                && "COMPRESSION".equals(regime)) {
                            if ("BUY".equals(signals.get(lbl))) continue;
                        }

                        String sig = signals.get(lbl);
                        if (sig == null || "HOLD".equals(sig)) continue;

                        boolean isBuy = "BUY".equals(sig);
                        StrategyScorer.ScoreResult sc = combinedScorer.score(
                                cfg.getStrategyType(), isBuy, regime, instrType);

                        // OPTION: distrust high vol score
                        if (isOption && rulesOn && optionRules.isDistrustHighVolScore()) {
                            if (sc.getVolatilityScore() > optionRules.getVolScoreMax()) continue;
                        }

                        allScoredTuples.add(new String[]{lbl, sig, String.format("%.1f", sc.getTotal())});
                        if (sc.getTotal() < minScore) continue;

                        combinedCandidates.add(lbl + ":" + sig + String.format("(%.1f)", sc.getTotal()));
                        if (bestScore == null || sc.getTotal() > bestScore.getTotal()) {
                            bestScore = sc; bestLabel = lbl; bestSignal = sig;
                        }
                    }
                    combinedWinner      = bestLabel;
                    combinedWinnerScore = bestScore != null ? bestScore.getTotal() : null;
                    combinedAllScored = allScoredTuples.stream()
                            .sorted((a, b) -> Double.compare(Double.parseDouble(b[2]), Double.parseDouble(a[2])))
                            .map(t -> t[0] + " " + t[1] + " score=" + t[2])
                            .collect(java.util.stream.Collectors.toList());
                }

                // ── Entry Filters ──────────────────────────────────────────
                if (bestLabel != null && bestSignal != null && efEnabled) {
                    boolean efForThis = isOption ? efCfg.getScoreGap().isOptions() || efCfg.getCooldown().isOptions()
                            || efCfg.getVwapExtension().isOptions() || efCfg.getStrategyFilter().isOptions()
                            || efCfg.getConfidenceGate().isOptions()
                            : efCfg.getScoreGap().isStocks() || efCfg.getCooldown().isStocks()
                            || efCfg.getVwapExtension().isStocks() || efCfg.getStrategyFilter().isStocks()
                            || efCfg.getConfidenceGate().isStocks();
                    if (efForThis) {
                        double computedScoreGap = 0;
                        if (allScoredTuples.size() >= 2) {
                            List<String[]> sorted = allScoredTuples.stream()
                                    .sorted((a, b) -> Double.compare(Double.parseDouble(b[2]), Double.parseDouble(a[2])))
                                    .collect(java.util.stream.Collectors.toList());
                            computedScoreGap = Double.parseDouble(sorted.get(0)[2]) - Double.parseDouble(sorted.get(1)[2]);
                        } else if (allScoredTuples.size() == 1) {
                            computedScoreGap = Double.parseDouble(allScoredTuples.get(0)[2]);
                        }

                        String efBlock = null;
                        // Rule: Score Gap
                        boolean sgActive = isOption ? efCfg.getScoreGap().isOptions() : efCfg.getScoreGap().isStocks();
                        if (efBlock == null && sgActive && computedScoreGap < efCfg.getMinGap())
                            efBlock = "Score gap " + String.format("%.1f", computedScoreGap) + " < " + efCfg.getMinGap();
                        // Rule: Cooldown
                        boolean cdActive = isOption ? efCfg.getCooldown().isOptions() : efCfg.getCooldown().isStocks();
                        if (efBlock == null && cdActive && barsSinceLastExit < efCfg.getMinBars())
                            efBlock = "Cooldown " + barsSinceLastExit + " < " + efCfg.getMinBars();
                        // Rule: VWAP Extension
                        boolean veActive = isOption ? efCfg.getVwapExtension().isOptions() : efCfg.getVwapExtension().isStocks();
                        Double distVwap = currentVwap > 0 ? ((cC - currentVwap) / currentVwap * 100.0) : null;
                        if (efBlock == null && veActive && distVwap != null && Math.abs(distVwap) > efCfg.getMaxDistPct())
                            efBlock = "VWAP ext " + String.format("%.2f", distVwap) + "% > " + efCfg.getMaxDistPct() + "%";
                        // Rule: Strategy Filter (blocked list)
                        boolean sfActive = isOption ? efCfg.getStrategyFilter().isOptions() : efCfg.getStrategyFilter().isStocks();
                        if (efBlock == null && sfActive && efCfg.getBlocked() != null) {
                            for (String blocked : efCfg.getBlocked().split(",")) {
                                if (bestLabel.equalsIgnoreCase(blocked.trim())) {
                                    efBlock = "Strategy " + bestLabel + " is blocked"; break;
                                }
                            }
                        }
                        // Rule: Confidence Gate
                        boolean cgActive = isOption ? efCfg.getConfidenceGate().isOptions() : efCfg.getConfidenceGate().isStocks();
                        if (efBlock == null && cgActive) {
                            String exception = efCfg.getExceptionStrategy() != null ? efCfg.getExceptionStrategy().trim() : "";
                            if (computedScoreGap < efCfg.getMinConfGap() && !bestLabel.equalsIgnoreCase(exception))
                                efBlock = "Confidence gap " + String.format("%.1f", computedScoreGap) + " < " + efCfg.getMinConfGap();
                        }

                        if (efBlock != null) {
                            combinedBlockReason = (combinedBlockReason != null ? combinedBlockReason + "; " : "") + "[EF] " + efBlock;
                            bestLabel = null; bestSignal = null; // suppress entry
                        }
                    }
                }

                if (bestLabel != null && bestSignal != null) {
                    boolean isBuyBest = "BUY".equals(bestSignal);
                    boolean cHasLong  = combinedPos != null && combinedPos.type == PositionDirection.LONG;
                    boolean cHasShort = combinedPos != null && combinedPos.type == PositionDirection.SHORT;
                    boolean noSCR     = rulesOn && (isOption
                            ? optionRules.isNoSameCandleReversal()
                            : stockRules.isNoSameCandleReversal());

                    // Find the cfg for bestLabel to check its allowShorting
                    final String finalBestLabel = bestLabel;
                    StrategyConfig bestCfg = stratCfgs.stream()
                            .filter(c -> resolveLabel(c).equals(finalBestLabel)).findFirst().orElse(null);
                    boolean bestAllowShort = bestCfg != null && isAllowShorting(bestCfg);

                    String trigger = buildTrigger(bestScore);
                    final StrategyScorer.ScoreResult finalBestScore = bestScore;

                    if (isBuyBest) {
                        if (cHasShort) {
                            if (!(noSCR && "SHORT".equals(candleClosedDir.get(COMBINED_LABEL)))) {
                                // Check combined long gate
                                boolean passesGate = combinedLongGateCheck(cC, regime, instrType, finalBestScore,
                                        combinedRevCooldown, currentVwap, rulesOn, stockRules, isOption);
                                // Close short
                                ClosedTrade ct = closePositionDirect(combinedPos, cC, candleTime, "SIGNAL", regime,
                                        combinedCapital, combinedTrades, combinedEquities);
                                combinedCapital = BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP);
                                combinedPos = null;
                                candleClosedDir.put(COMBINED_LABEL, "SHORT");
                                combinedDetails.add(CombinedDetail.builder()
                                        .action("Exit Short").reason("Signal").exitReason("SIGNAL")
                                        .price(cC).regime(regime).sourceStrategy(bestLabel).trigger(trigger)
                                        .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());

                                if (bestAllowShort && passesGate) {
                                    int qty = sizeQty(resolvedQty, combinedCapital, cC, riskFrac, slFrac);
                                    combinedPos = buildPosition(PositionDirection.LONG, cC, qty, candleTime,
                                            regime, bestLabel, slFrac, tpFrac);
                                    combinedRevCooldown = 2;
                                    combinedDetails.add(CombinedDetail.builder()
                                            .action("Enter Long").reason("Reversal SHORT->LONG")
                                            .price(cC).regime(regime).sourceStrategy(bestLabel).trigger(trigger)
                                            .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                                } else if (!passesGate) {
                                    combinedBlockReason = "LONG quality gate (post-short-exit)";
                                }
                            } else {
                                combinedBlockReason = "same-candle reversal (BUY after SHORT close)";
                            }
                        } else if (!cHasLong) {
                            boolean passesGate = combinedLongGateCheck(cC, regime, instrType, finalBestScore,
                                    combinedRevCooldown, currentVwap, rulesOn, stockRules, isOption);
                            if (passesGate) {
                                int qty = sizeQty(resolvedQty, combinedCapital, cC, riskFrac, slFrac);
                                combinedPos = buildPosition(PositionDirection.LONG, cC, qty, candleTime,
                                        regime, bestLabel, slFrac, tpFrac);
                                combinedDetails.add(CombinedDetail.builder()
                                        .action("Enter Long").reason("Signal")
                                        .price(cC).regime(regime).sourceStrategy(bestLabel).trigger(trigger)
                                        .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                            } else {
                                combinedBlockReason = "LONG quality gate";
                            }
                        }
                    } else { // SELL
                        if (cHasLong) {
                            if (!(noSCR && "LONG".equals(candleClosedDir.get(COMBINED_LABEL)))) {
                                ClosedTrade ct = closePositionDirect(combinedPos, cC, candleTime, "SIGNAL", regime,
                                        combinedCapital, combinedTrades, combinedEquities);
                                combinedCapital = BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP);
                                combinedPos = null;
                                candleClosedDir.put(COMBINED_LABEL, "LONG");
                                combinedDetails.add(CombinedDetail.builder()
                                        .action("Exit Long").reason("Signal").exitReason("SIGNAL")
                                        .price(cC).regime(regime).sourceStrategy(bestLabel).trigger(trigger)
                                        .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                                if (bestAllowShort) {
                                    int qty = sizeQty(resolvedQty, combinedCapital, cC, riskFrac, slFrac);
                                    combinedPos = buildPosition(PositionDirection.SHORT, cC, qty, candleTime,
                                            regime, bestLabel, slFrac, tpFrac);
                                    combinedRevCooldown = 2;
                                    combinedDetails.add(CombinedDetail.builder()
                                            .action("Enter Short").reason("Reversal LONG->SHORT")
                                            .price(cC).regime(regime).sourceStrategy(bestLabel).trigger(trigger)
                                            .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                                }
                            } else {
                                combinedBlockReason = "same-candle reversal (SELL after LONG close)";
                            }
                        } else if (!cHasShort && bestAllowShort) {
                            int qty = sizeQty(resolvedQty, combinedCapital, cC, riskFrac, slFrac);
                            combinedPos = buildPosition(PositionDirection.SHORT, cC, qty, candleTime,
                                    regime, bestLabel, slFrac, tpFrac);
                            combinedDetails.add(CombinedDetail.builder()
                                    .action("Enter Short").reason("Signal")
                                    .price(cC).regime(regime).sourceStrategy(bestLabel).trigger(trigger)
                                    .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                        } else if (!cHasShort) {
                            combinedBlockReason = "shorting disabled for " + bestLabel;
                        }
                    }
                }
            } // end combined pool

            // ── Fill in HOLD signals for strategies that were skipped ──────
            for (StrategyConfig cfg : stratCfgs) {
                String label = resolveLabel(cfg);
                signals.putIfAbsent(label, "HOLD");
            }

            // ── Build strategyStates snapshot ──────────────────────────────
            Map<String, StrategyState> stratStates = new LinkedHashMap<>();
            for (StrategyConfig cfg : stratCfgs) {
                String label = resolveLabel(cfg);
                stratStates.put(label, buildStrategyState(
                        capitals.get(label), positions.get(label), trades.get(label), equities.get(label)));
            }
            if (scoreOn) {
                stratStates.put(COMBINED_LABEL, buildStrategyState(
                        combinedCapital, combinedPos, combinedTrades, combinedEquities));
            }

            // Track combined exit for cooldown filter
            if (combinedPosBeforeCandle != null && combinedPos == null) {
                combinedLastExitCandle = combinedCandleIndex;
            }

            // ── Emit SSE event ─────────────────────────────────────────────
            emitted++;
            ReplayCandleEvent event = ReplayCandleEvent.builder()
                    .candleTime(candleTime)
                    .open(cO).high(cH).low(cL).close(cC).volume(cV)
                    .regime(regime)
                    .signals(signals)
                    .actions(actions)
                    .blockedSignals(blockedSignals)
                    .combinedDetails(combinedDetails)
                    .combinedWinner(combinedWinner)
                    .combinedWinnerScore(combinedWinnerScore)
                    .combinedAllScored(combinedAllScored)
                    .combinedCandidates(combinedCandidates)
                    .combinedBlockReason(combinedBlockReason)
                    .vwap(eventVwap)
                    .distanceFromVwapPct(eventDistVwapPct)
                    .strategyStates(stratStates)
                    .emitted(emitted)
                    .total(total)
                    .build();

            try {
                String json = objectMapper.writeValueAsString(event);
                emitter.send(SseEmitter.event().name("candle").data(json));
            } catch (Exception e) {
                log.warn("Replay eval: SSE emit failed at candle {} — client likely disconnected", emitted);
                break;
            }

            // ── Speed-controlled sleep ─────────────────────────────────────
            if (sleepMs > 0 && ri < replayCandles.size() - 1) {
                try { Thread.sleep(sleepMs); } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        } // end replay candle loop

        // ── Force-close all open positions at end ─────────────────────────
        // (close them but don't emit — session is over)
        for (StrategyConfig cfg : stratCfgs) {
            String label = resolveLabel(cfg);
            PositionState pos = positions.get(label);
            if (pos != null && !replayCandles.isEmpty()) {
                CandleDto last = replayCandles.get(replayCandles.size() - 1);
                double lastClose = dbl(last.close());
                String lastTime  = last.openTime() != null ? last.openTime().format(DT_FMT) : "";
                closePosition(label, pos, lastClose, lastTime, "END_OF_BACKTEST",
                        regimeArr != null ? regimeArr[warmupOffset + replayCandles.size() - 1] : null,
                        capitals, trades, equities);
            }
        }
        if (scoreOn && combinedPos != null && !replayCandles.isEmpty()) {
            CandleDto last = replayCandles.get(replayCandles.size() - 1);
            double lastClose = dbl(last.close());
            String lastTime  = last.openTime() != null ? last.openTime().format(DT_FMT) : "";
            ClosedTrade ct = closePositionDirect(combinedPos, lastClose, lastTime, "END_OF_BACKTEST",
                    regimeArr != null ? regimeArr[warmupOffset + replayCandles.size() - 1] : null,
                    combinedCapital, combinedTrades, combinedEquities);
            combinedCapital = BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP);
            combinedPos = null;
        }

        // Emit final summary event so frontend gets updated strategyStates after force-close
        if (!replayCandles.isEmpty()) {
            try {
                Map<String, StrategyState> finalStates = new LinkedHashMap<>();
                for (StrategyConfig cfg : stratCfgs) {
                    String label = resolveLabel(cfg);
                    finalStates.put(label, buildStrategyState(
                            capitals.get(label), positions.get(label), trades.get(label), equities.get(label)));
                }
                if (scoreOn) {
                    finalStates.put(COMBINED_LABEL, buildStrategyState(
                            combinedCapital, null, combinedTrades, combinedEquities));
                }
                String summaryJson = objectMapper.writeValueAsString(Map.of("strategyStates", finalStates));
                emitter.send(SseEmitter.event().name("summary").data(summaryJson));
            } catch (Exception e) {
                log.warn("Failed to emit summary event: {}", e.getMessage());
            }
        }

        // Clean up strategy state
        for (StrategyConfig cfg : stratCfgs) {
            String label = resolveLabel(cfg);
            logicMap.get(label).onInstanceRemoved(instanceIds.get(label));
        }

        log.info("Replay eval complete: {} candles emitted", emitted);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private StrategyContext buildCtx(String instanceId, StrategyConfig cfg, ReplayRequest req,
                                      int qty, PositionDirection dir, boolean allowShort, CandleDto candle) {
        return StrategyContext.builder()
                .instanceId(instanceId)
                .strategyType(cfg.getStrategyType())
                .userId(req.getUserId())
                .brokerName(req.getBrokerName())
                .symbol(req.getSymbol().toUpperCase())
                .exchange(req.getExchange().toUpperCase())
                .product(req.getProduct() != null ? req.getProduct() : "MIS")
                .quantity(qty)
                .orderType("MARKET")
                .currentDirection(dir)
                .allowShorting(allowShort)
                .candleOpenTime(candle.openTime() != null ? candle.openTime().toInstant(ZoneOffset.UTC) : null)
                .candleOpen(candle.open())
                .candleHigh(candle.high())
                .candleLow(candle.low())
                .candleClose(candle.close())
                .candleVolume(candle.volume() != null ? candle.volume() : 0L)
                .params(cfg.getParameters() != null ? cfg.getParameters() : Map.of())
                .build();
    }

    /**
     * Opens a position and stores it. Returns the created PositionState.
     */
    private PositionState openPosition(String label, PositionDirection type, double price, int qty,
                                        String entryTime, String regime, String sourceStrategy,
                                        BigDecimal slFrac, BigDecimal tpFrac,
                                        Map<String, PositionState> positions,
                                        Map<String, BigDecimal> capitals) {
        Double slPrice = null, tpPrice = null;
        if (type == PositionDirection.LONG) {
            if (slFrac != null) slPrice = price * (1.0 - slFrac.doubleValue());
            if (tpFrac != null) tpPrice = price * (1.0 + tpFrac.doubleValue());
        } else {
            if (slFrac != null) slPrice = price * (1.0 + slFrac.doubleValue());
            if (tpFrac != null) tpPrice = price * (1.0 - tpFrac.doubleValue());
        }
        PositionState pos = new PositionState(type, price, qty, entryTime, regime, sourceStrategy, slPrice, tpPrice);
        positions.put(label, pos);
        return pos;
    }

    /**
     * Builds a PositionState for the combined pool (no positions map).
     */
    private PositionState buildPosition(PositionDirection type, double price, int qty,
                                         String entryTime, String regime, String sourceStrategy,
                                         BigDecimal slFrac, BigDecimal tpFrac) {
        Double slPrice = null, tpPrice = null;
        if (type == PositionDirection.LONG) {
            if (slFrac != null) slPrice = price * (1.0 - slFrac.doubleValue());
            if (tpFrac != null) tpPrice = price * (1.0 + tpFrac.doubleValue());
        } else {
            if (slFrac != null) slPrice = price * (1.0 + slFrac.doubleValue());
            if (tpFrac != null) tpPrice = price * (1.0 - tpFrac.doubleValue());
        }
        return new PositionState(type, price, qty, entryTime, regime, sourceStrategy, slPrice, tpPrice);
    }

    /**
     * Closes a position and updates capital/trades/equity maps. Returns the ClosedTrade.
     */
    private ClosedTrade closePosition(String label, PositionState pos, double exitPrice,
                                       String exitTime, String exitReason, String regime,
                                       Map<String, BigDecimal> capitals,
                                       Map<String, List<ClosedTrade>> trades,
                                       Map<String, List<EquityPoint>> equities) {
        BigDecimal cap = capitals.get(label);
        ClosedTrade ct = closePositionDirect(pos, exitPrice, exitTime, exitReason, regime, cap,
                trades.get(label), equities.get(label));
        capitals.put(label, BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP));
        return ct;
    }

    private ClosedTrade closePositionDirect(PositionState pos, double exitPrice,
                                             String exitTime, String exitReason, String regime,
                                             BigDecimal capitalBefore,
                                             List<ClosedTrade> tradeList,
                                             List<EquityPoint> equityList) {
        double pnl;
        if (pos.type == PositionDirection.SHORT) {
            pnl = (pos.entryPrice - exitPrice) * pos.qty;
        } else {
            pnl = (exitPrice - pos.entryPrice) * pos.qty;
        }
        double capitalAfter = capitalBefore.doubleValue() + pnl;
        double notional = pos.entryPrice * pos.qty;
        double pnlPct   = notional > 0 ? (pnl / notional) * 100.0 : 0.0;

        ClosedTrade ct = ClosedTrade.builder()
                .type(pos.type.name())
                .entryTime(pos.entryTime)
                .exitTime(exitTime)
                .exitReason(exitReason)
                .regime(regime)
                .sourceStrategy(pos.sourceStrategy)
                .entryPrice(pos.entryPrice)
                .exitPrice(exitPrice)
                .pnl(Math.round(pnl * 100.0) / 100.0)
                .pnlPct(Math.round(pnlPct * 100.0) / 100.0)
                .capitalAfter(Math.round(capitalAfter * 100.0) / 100.0)
                .qty(pos.qty)
                .build();

        tradeList.add(ct);
        equityList.add(EquityPoint.builder().time(exitTime).capital(capitalAfter).build());
        return ct;
    }

    private StrategyState buildStrategyState(BigDecimal capital, PositionState pos,
                                              List<ClosedTrade> trades, List<EquityPoint> equity) {
        OpenPosition openPos = null;
        if (pos != null) {
            openPos = OpenPosition.builder()
                    .type(pos.type.name())
                    .entryPrice(pos.entryPrice)
                    .qty(pos.qty)
                    .entryTime(pos.entryTime)
                    .slPrice(pos.slPrice)
                    .tpPrice(pos.tpPrice)
                    .regime(pos.regime)
                    .sourceStrategy(pos.sourceStrategy)
                    .build();
        }
        return StrategyState.builder()
                .capital(capital.doubleValue())
                .openPosition(openPos)
                .closedTrades(new ArrayList<>(trades))
                .equityHistory(new ArrayList<>(equity))
                .build();
    }

    /**
     * LONG quality gate: returns a block reason string if the entry should be blocked, null if OK.
     * Only applies to STOCK instrument type when rules are enabled.
     */
    private String longGateBlock(String label, double price, String regime, String instrType,
                                  StrategyScorer.ScoreResult score, int revCooldown, double vwap,
                                  boolean rulesOn, StockRules stockRules, boolean isOption) {
        if (isOption || !rulesOn) return null;
        LongQualityGate gate = stockRules.getLongQualityGate();
        if (gate == null || !gate.isEnabled()) return null;

        if (score.getTotal() < gate.getScoreMin()) {
            return String.format("Rule: LONG gate — score %.1f < %.0f", score.getTotal(), gate.getScoreMin());
        }
        if (revCooldown > 0) {
            return "Rule: LONG gate — reversal cooldown active";
        }
        if (vwap > 0) {
            double extPct = Math.abs(price - vwap) / vwap * 100.0;
            if (extPct > gate.getVwapMaxPct()) {
                return String.format("Rule: LONG gate — price %.2f%% from VWAP (max %.1f%%)", extPct, gate.getVwapMaxPct());
            }
        }
        return null;
    }

    /** Combined pool variant of the long gate check — returns boolean (no label context needed). */
    private boolean combinedLongGateCheck(double price, String regime, String instrType,
                                           StrategyScorer.ScoreResult score, int revCooldown, double vwap,
                                           boolean rulesOn, StockRules stockRules, boolean isOption) {
        if (isOption || !rulesOn) return true;
        LongQualityGate gate = stockRules.getLongQualityGate();
        if (gate == null || !gate.isEnabled()) return true;

        if (score.getTotal() < gate.getScoreMin()) return false;
        if (revCooldown > 0) return false;
        if (vwap > 0) {
            double extPct = Math.abs(price - vwap) / vwap * 100.0;
            if (extPct > gate.getVwapMaxPct()) return false;
        }
        return true;
    }

    private int sizeQty(int resolvedQty, BigDecimal capital, double entryPrice,
                         BigDecimal riskFrac, BigDecimal slFrac) {
        if (riskFrac == null || slFrac == null || slFrac.compareTo(BigDecimal.ZERO) == 0) {
            return resolvedQty;
        }
        // qty = floor(capital * riskPct / (entryPrice * slPct))
        double riskAmount = capital.doubleValue() * riskFrac.doubleValue();
        double slAmount   = entryPrice * slFrac.doubleValue();
        if (slAmount <= 0) return resolvedQty;
        return Math.max(1, (int) Math.floor(riskAmount / slAmount));
    }

    private static String resolveLabel(StrategyConfig cfg) {
        return (cfg.getLabel() != null && !cfg.getLabel().isBlank())
                ? cfg.getLabel() : cfg.getStrategyType();
    }

    /** All strategies default to allowShorting=true in replay (matches frontend default). */
    private static boolean isAllowShorting(StrategyConfig cfg) {
        return true; // Replay always enables shorting (matches JS: allowShorting: true)
    }

    private static BigDecimal fracOrNull(BigDecimal pct) {
        if (pct == null || pct.compareTo(BigDecimal.ZERO) <= 0) return null;
        return pct.divide(BigDecimal.valueOf(100), 8, RoundingMode.HALF_UP);
    }

    private static double dbl(BigDecimal bd) {
        return bd != null ? bd.doubleValue() : 0.0;
    }

    private static String buildTrigger(StrategyScorer.ScoreResult sc) {
        return String.format(
                "Score-based signal (final=%.1f, base=%.1f, trend=%.1f, vol=%.1f, mom=%.1f, conf=%.1f, pen=%.1f)",
                sc.getTotal(), sc.getBaseScore(),
                sc.getTrendStrength(), sc.getVolatilityScore(),
                sc.getMomentumScore(), sc.getConfidenceScore(),
                sc.getTotalPenalty());
    }

    // ─── Inner state classes ──────────────────────────────────────────────────

    /** Mutable position state held server-side per label. */
    private static final class PositionState {
        final PositionDirection type;
        final double            entryPrice;
        final int               qty;
        final String            entryTime;
        final String            regime;
        final String            sourceStrategy;
        final Double            slPrice;
        final Double            tpPrice;

        PositionState(PositionDirection type, double entryPrice, int qty,
                      String entryTime, String regime, String sourceStrategy,
                      Double slPrice, Double tpPrice) {
            this.type           = type;
            this.entryPrice     = entryPrice;
            this.qty            = qty;
            this.entryTime      = entryTime;
            this.regime         = regime;
            this.sourceStrategy = sourceStrategy;
            this.slPrice        = slPrice;
            this.tpPrice        = tpPrice;
        }
    }

    /** Daily loss cap tracking state. */
    private static final class DailyCapState {
        final LocalDate  date;
        final BigDecimal startCapital;
        final boolean    halted;

        DailyCapState(LocalDate date, BigDecimal startCapital, boolean halted) {
            this.date         = date;
            this.startCapital = startCapital;
            this.halted       = halted;
        }
    }
}
