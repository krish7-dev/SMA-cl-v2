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
import com.sma.strategyengine.model.request.LiveEvalRequest;
import com.sma.strategyengine.model.request.LiveEvalRequest.InstrumentConfig;
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
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.*;

/**
 * Live strategy evaluation service.
 *
 * <p>Each call to {@link #start(LiveEvalRequest, SseEmitter)} creates a new
 * {@link LiveSession} that:
 * <ol>
 *   <li>Preloads historical candles to warm up indicator/regime/scorer windows.</li>
 *   <li>Subscribes to the Data Engine tick SSE stream via a blocking HTTP thread.</li>
 *   <li>Builds candles from ticks per instrument using the configured {@code candleInterval}.</li>
 *   <li>On each candle close, runs the full evaluation pipeline (same as ReplayEvalService).</li>
 *   <li>Emits enriched {@link ReplayCandleEvent} objects (wrapped with instrumentToken/symbol) via SSE.</li>
 * </ol>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class LiveEvalService {

    public static final String COMBINED_LABEL = "\u26a1 Combined";

    private static final DateTimeFormatter DT_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm");

    private static final Map<String, Long> INTERVAL_MS = Map.of(
            "MINUTE_1",  60_000L,
            "MINUTE_3",  180_000L,
            "MINUTE_5",  300_000L,
            "MINUTE_10", 600_000L,
            "MINUTE_15", 900_000L,
            "MINUTE_30", 1_800_000L,
            "MINUTE_60", 3_600_000L,
            "DAY",       86_400_000L
    );

    private final DataEngineClient dataEngineClient;
    private final StrategyRegistry strategyRegistry;
    private final ObjectMapper     objectMapper;

    @Value("${strategy.data-engine.base-url:http://localhost:9005}")
    private String dataEngineBaseUrl;

    private final ConcurrentHashMap<String, LiveSession> sessions = new ConcurrentHashMap<>();

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "live-eval-" + System.nanoTime());
        t.setDaemon(true);
        return t;
    });

    // ─── Public API ───────────────────────────────────────────────────────────

    public String start(LiveEvalRequest req, SseEmitter emitter) {
        String sessionId = UUID.randomUUID().toString();
        LiveSession session = new LiveSession(sessionId, req, emitter);
        sessions.put(sessionId, session);

        // Emit init event immediately
        try {
            String initJson = objectMapper.writeValueAsString(
                    Map.of("sessionId", sessionId, "instruments", req.getInstruments().size()));
            emitter.send(SseEmitter.event().name("init").data(initJson));
        } catch (Exception e) {
            log.warn("Live eval: failed to send init event for session {}", sessionId);
        }

        emitter.onCompletion(() -> cleanup(sessionId));
        emitter.onError(e -> cleanup(sessionId));

        executor.execute(() -> {
            try {
                session.run();
            } catch (Exception e) {
                log.error("Live eval session {} failed: {}", sessionId, e.getMessage(), e);
                cleanup(sessionId);
                try { emitter.completeWithError(e); } catch (Exception ignored) {}
            }
        });

        log.info("Live eval session {} started: {} instrument(s), interval={}",
                sessionId, req.getInstruments().size(), req.getCandleInterval());
        return sessionId;
    }

    public SseEmitter getEmitter(String sessionId) {
        LiveSession s = sessions.get(sessionId);
        return s != null ? s.emitter : null;
    }

    public void stop(String sessionId) {
        cleanup(sessionId);
        log.info("Live eval session {} stopped externally", sessionId);
    }

    private void cleanup(String sessionId) {
        LiveSession session = sessions.remove(sessionId);
        if (session != null) session.stop();
    }

    // ─── LiveSession ──────────────────────────────────────────────────────────

    private class LiveSession {

        final String         sessionId;
        final LiveEvalRequest req;
        final SseEmitter     emitter;

        // Instrument configs indexed by token
        final Map<Long, InstrumentConfig> instrByToken = new LinkedHashMap<>();

        // Per-instrument evaluation state
        final Map<Long, InstrEvalState> evalStates = new ConcurrentHashMap<>();

        // Resolved per-trade quantity
        volatile int     resolvedQty = 1;
        volatile boolean qtyResolved = false;

        // Unpacked request config (resolved once in constructor)
        final RiskConfig    riskCfg;
        final PatternConfig patCfg;
        final RegimeConfig  regimeCfg;
        final ScoreConfig   scoreCfg;
        final RulesConfig   rulesCfg;
        final StockRules    stockRules;
        final OptionRules   optionRules;

        final boolean riskOn;
        final boolean patternOn;
        final boolean regimeOn;
        final boolean scoreOn;
        final boolean rulesOn;
        final boolean combinedOnlyMode;

        final BigDecimal slFrac;
        final BigDecimal tpFrac;
        final BigDecimal riskFrac;
        final BigDecimal capFrac;
        final double     minScore;

        final List<StrategyConfig> stratCfgs;
        final BigDecimal           initCap;
        final int                  requestedQty;
        final long                 ivMs;

        // Forming candle state per token
        final ConcurrentHashMap<Long, FormingCandle> formingCandles = new ConcurrentHashMap<>();

        // Candle emitted counters per token
        final ConcurrentHashMap<Long, Integer> emittedByToken = new ConcurrentHashMap<>();

        volatile boolean  stopped    = false;
        volatile Future<?> tickFuture = null;

        LiveSession(String sessionId, LiveEvalRequest req, SseEmitter emitter) {
            this.sessionId = sessionId;
            this.req       = req;
            this.emitter   = emitter;

            for (InstrumentConfig ic : req.getInstruments()) {
                instrByToken.put(ic.getInstrumentToken(), ic);
            }

            riskCfg  = req.getRiskConfig();
            patCfg   = req.getPatternConfig();
            regimeCfg = req.getRegimeConfig();
            scoreCfg  = req.getScoreConfig();
            rulesCfg  = req.getRulesConfig() != null ? req.getRulesConfig() : new RulesConfig();

            riskOn    = riskCfg  != null && riskCfg.isEnabled();
            patternOn = patCfg   != null && patCfg.isEnabled();
            regimeOn  = regimeCfg != null && regimeCfg.isEnabled();
            scoreOn   = scoreCfg  != null && scoreCfg.isEnabled();
            rulesOn   = rulesCfg.isEnabled();
            combinedOnlyMode = req.isCombinedOnlyMode() && scoreOn;

            stockRules  = rulesCfg.getStocks()  != null ? rulesCfg.getStocks()  : new StockRules();
            optionRules = rulesCfg.getOptions() != null ? rulesCfg.getOptions() : new OptionRules();

            slFrac   = fracOrNull(riskCfg == null ? null : riskCfg.getStopLossPct());
            tpFrac   = fracOrNull(riskCfg == null ? null : riskCfg.getTakeProfitPct());
            riskFrac = (riskOn && slFrac != null) ? fracOrNull(riskCfg.getMaxRiskPerTradePct()) : null;
            capFrac  = fracOrNull(riskCfg == null ? null : riskCfg.getDailyLossCapPct());
            minScore = scoreCfg != null ? scoreCfg.getMinScoreThreshold() : 30.0;

            stratCfgs    = req.getStrategies();
            initCap      = req.getInitialCapital();
            requestedQty = req.getQuantity();
            ivMs         = INTERVAL_MS.getOrDefault(req.getCandleInterval(), 300_000L);
        }

        void run() throws Exception {
            // ── Phase 1: Initialise per-instrument eval state ──────────────────
            for (InstrumentConfig ic : req.getInstruments()) {
                InstrEvalState state = new InstrEvalState(ic, stratCfgs, initCap, patternOn, patCfg);
                // Populate strategy logic (needs strategyRegistry from outer service)
                for (StrategyConfig cfg : stratCfgs) {
                    String label = resolveLabel(cfg);
                    state.instanceIds.put(label, "LV-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10).toUpperCase());
                    state.logicMap.put(label, strategyRegistry.resolve(cfg.getStrategyType()));
                    state.scorerMap.put(label, new StrategyScorer());
                }
                evalStates.put(ic.getInstrumentToken(), state);
                emittedByToken.put(ic.getInstrumentToken(), 0);
            }

            // ── Phase 2: Preload warmup candles ────────────────────────────────
            int preloadDays = Math.max(0, req.getPreloadDaysBack());
            String preloadInterval = (req.getPreloadInterval() != null && !req.getPreloadInterval().isBlank())
                    ? req.getPreloadInterval() : req.getCandleInterval();

            if (preloadDays > 0) {
                // Use IST as the reference timezone for market data
                ZoneId ist = ZoneId.of("Asia/Kolkata");
                LocalDateTime now = LocalDateTime.now(ist);
                LocalDateTime warmupTo   = now;
                LocalDateTime warmupFrom = now.minusDays((long) preloadDays + 7)
                        .withHour(9).withMinute(15).withSecond(0);

                for (InstrumentConfig ic : req.getInstruments()) {
                    if (stopped) return;
                    try {
                        List<CandleDto> warmupCandles = dataEngineClient.fetchHistory(new HistoryRequest(
                                req.getUserId(), req.getBrokerName(), ic.getInstrumentToken(),
                                ic.getSymbol().toUpperCase(), ic.getExchange().toUpperCase(),
                                preloadInterval, warmupFrom, warmupTo, true));

                        log.info("Live eval session {}: preloaded {} warmup candles for {}",
                                sessionId, warmupCandles.size(), ic.getSymbol());

                        InstrEvalState state = evalStates.get(ic.getInstrumentToken());
                        feedWarmupCandles(state, ic, warmupCandles);

                        try {
                            String json = objectMapper.writeValueAsString(Map.of(
                                    "type", "preload_done",
                                    "instrumentToken", ic.getInstrumentToken(),
                                    "symbol", ic.getSymbol(),
                                    "count", warmupCandles.size()));
                            emitter.send(SseEmitter.event().name("info").data(json));
                        } catch (Exception ignored) {}

                    } catch (Exception e) {
                        log.warn("Live eval session {}: warmup fetch failed for {} (non-fatal): {}",
                                sessionId, ic.getSymbol(), e.getMessage());
                    }
                }
            }

            // ── Phase 3: Subscribe to Data Engine tick SSE ─────────────────────
            if (!stopped) {
                tickFuture = executor.submit(this::readTickStream);
            }
        }

        private void feedWarmupCandles(InstrEvalState state, InstrumentConfig ic, List<CandleDto> candles) {
            for (CandleDto wc : candles) {
                double wO = dbl(wc.open()), wH = dbl(wc.high()), wL = dbl(wc.low()), wC = dbl(wc.close());
                long   wV = wc.volume() != null ? wc.volume() : 1L;

                for (StrategyScorer sc : state.scorerMap.values()) sc.push(wO, wH, wL, wC);
                state.combinedScorer.push(wO, wH, wL, wC);

                for (StrategyConfig cfg : stratCfgs) {
                    String label = resolveLabel(cfg);
                    StrategyContext ctx = buildCtx(state.instanceIds.get(label), cfg, ic,
                            resolvedQty, PositionDirection.FLAT, false, wc);
                    state.logicMap.get(label).evaluate(ctx);
                }

                if (wc.open() != null) {
                    CandlePatternDetector.detect(state.patPrev2, state.patPrev1, wO, wH, wL, wC,
                            state.pMinWick, state.pMaxBody);
                    state.patPrev2 = state.patPrev1;
                    state.patPrev1 = new double[]{wO, wH, wL, wC};
                }

                if (wc.openTime() != null) {
                    LocalDate day = wc.openTime().toLocalDate();
                    if (!day.equals(state.vwapDay)) { state.vwapDay = day; state.vwapSumTV = 0; state.vwapSumV = 0; }
                }
                state.vwapSumTV += ((wH + wL + wC) / 3.0) * wV;
                state.vwapSumV  += wV;

                // Regime history for incremental detection
                state.regimeHighs.add(wH);
                state.regimeLows.add(wL);
                state.regimeCloses.add(wC);

                if (!qtyResolved && wc.close() != null && dbl(wc.close()) > 0) {
                    resolveQty(dbl(wc.close()));
                }
            }
        }

        private synchronized void resolveQty(double firstClose) {
            if (qtyResolved) return;
            if (requestedQty > 0) {
                resolvedQty = requestedQty;
            } else if (firstClose > 0) {
                int autoQty = initCap.divide(BigDecimal.valueOf(firstClose), 0, RoundingMode.FLOOR).intValue();
                resolvedQty = Math.max(1, autoQty);
            } else {
                resolvedQty = 1;
            }
            qtyResolved = true;
        }

        /** Blocking SSE reader loop — reconnects on error. */
        private void readTickStream() {
            HttpClient httpClient = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(10))
                    .build();

            while (!stopped) {
                try {
                    HttpRequest request = HttpRequest.newBuilder()
                            .uri(URI.create(dataEngineBaseUrl + "/api/v1/data/stream/ticks"))
                            .header("Accept", "text/event-stream")
                            .GET()
                            .build();

                    HttpResponse<InputStream> response = httpClient.send(
                            request, HttpResponse.BodyHandlers.ofInputStream());

                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(response.body()))) {

                        String line;
                        String eventName = null;
                        StringBuilder dataBuffer = new StringBuilder();

                        while (!stopped && (line = reader.readLine()) != null) {
                            if (line.startsWith("event:")) {
                                eventName = line.substring(6).trim();
                            } else if (line.startsWith("data:")) {
                                dataBuffer.append(line.substring(5).trim());
                            } else if (line.isEmpty()) {
                                if ("tick".equals(eventName) && dataBuffer.length() > 0) {
                                    processTickJson(dataBuffer.toString());
                                }
                                eventName = null;
                                dataBuffer.setLength(0);
                            }
                        }
                    }

                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    if (!stopped) {
                        log.warn("Live eval session {}: tick stream error, reconnecting in 3s: {}",
                                sessionId, e.getMessage());
                        try { Thread.sleep(3000); } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                }
            }
        }

        private void processTickJson(String json) {
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> tick = objectMapper.readValue(json, Map.class);

                // Skip replay ticks
                if (Boolean.TRUE.equals(tick.get("replay"))) return;

                Object tokenObj = tick.get("instrumentToken");
                if (tokenObj == null) return;
                long token = ((Number) tokenObj).longValue();

                if (!instrByToken.containsKey(token)) return;

                Object ltpObj = tick.get("ltp");
                if (ltpObj == null) return;
                double ltp = ((Number) ltpObj).doubleValue();

                Object volObj = tick.get("volume");
                long   volumeToday = volObj != null ? ((Number) volObj).longValue() : 0L;

                long epochMs = System.currentTimeMillis();
                Object tsObj = tick.get("timestamp");
                if (tsObj instanceof String tsStr && !tsStr.isEmpty() && !"null".equals(tsStr)) {
                    try { epochMs = Instant.parse(tsStr).toEpochMilli(); } catch (Exception ignored) {}
                }

                processTick(token, ltp, volumeToday, epochMs);

            } catch (Exception e) {
                log.debug("Live eval session {}: failed to parse tick: {}", sessionId, e.getMessage());
            }
        }

        void processTick(long token, double ltp, long volumeToday, long epochMs) {
            if (stopped) return;

            long bucketStart = (epochMs / ivMs) * ivMs;
            FormingCandle cur = formingCandles.get(token);

            if (cur == null) {
                formingCandles.put(token, new FormingCandle(ltp, ltp, ltp, ltp, volumeToday, bucketStart));
            } else if (bucketStart > cur.startTime) {
                CandleDto closedCandle = cur.toClosedCandle(cur.startTime);
                formingCandles.put(token, new FormingCandle(ltp, ltp, ltp, ltp, volumeToday, bucketStart));
                onCandleClose(token, closedCandle);
            } else {
                cur.high  = Math.max(cur.high, ltp);
                cur.low   = Math.min(cur.low, ltp);
                cur.close = ltp;
                cur.volume = volumeToday;
            }
        }

        void onCandleClose(long token, CandleDto candle) {
            if (stopped) return;

            InstrumentConfig ic    = instrByToken.get(token);
            InstrEvalState   state = evalStates.get(token);
            if (ic == null || state == null) return;

            String  instrType = ic.getInstrumentType() != null ? ic.getInstrumentType().toUpperCase() : "STOCK";
            boolean isOption  = "OPTION".equals(instrType);

            double cO = dbl(candle.open()), cH = dbl(candle.high()),
                   cL = dbl(candle.low()),  cC = dbl(candle.close());
            long   cV = candle.volume() != null ? candle.volume() : 1L;
            String candleTime = candle.openTime() != null ? candle.openTime().format(DT_FMT) : "";

            if (!qtyResolved) resolveQty(cC);

            // ── Feed scorers ──────────────────────────────────────────────────
            for (StrategyScorer sc : state.scorerMap.values()) sc.push(cO, cH, cL, cC);
            state.combinedScorer.push(cO, cH, cL, cC);

            // ── Candle pattern detection ───────────────────────────────────────
            List<String> detectedPatterns = List.of();
            if (candle.open() != null) {
                detectedPatterns = CandlePatternDetector.detect(
                        state.patPrev2, state.patPrev1, cO, cH, cL, cC, state.pMinWick, state.pMaxBody);
                state.patPrev2 = state.patPrev1;
                state.patPrev1 = new double[]{cO, cH, cL, cC};
            }
            final List<String> fp = detectedPatterns;
            boolean patOkBuy  = state.buyConfirm.isEmpty()  || fp.stream().anyMatch(state.buyConfirm::contains);
            boolean patOkSell = state.sellConfirm.isEmpty() || fp.stream().anyMatch(state.sellConfirm::contains);

            // ── VWAP update ───────────────────────────────────────────────────
            if (candle.openTime() != null) {
                LocalDate day = candle.openTime().toLocalDate();
                if (!day.equals(state.vwapDay)) { state.vwapDay = day; state.vwapSumTV = 0; state.vwapSumV = 0; }
            }
            state.vwapSumTV += ((cH + cL + cC) / 3.0) * cV;
            state.vwapSumV  += cV;
            double currentVwap = state.vwapSumV > 0 ? state.vwapSumTV / state.vwapSumV : 0.0;

            // ── Incremental regime detection ───────────────────────────────────
            state.regimeHighs.add(cH);
            state.regimeLows.add(cL);
            state.regimeCloses.add(cC);
            // Keep history bounded (2000 candles is plenty for ADX warmup)
            if (state.regimeHighs.size() > 2000) {
                state.regimeHighs.remove(0);
                state.regimeLows.remove(0);
                state.regimeCloses.remove(0);
            }
            String regime = null;
            if (regimeOn) {
                int minRequired = regimeCfg.getAdxPeriod() * 2 + 1;
                if (state.regimeHighs.size() >= minRequired) {
                    int sz = state.regimeHighs.size();
                    double[] H = state.regimeHighs.stream().mapToDouble(Double::doubleValue).toArray();
                    double[] L = state.regimeLows.stream().mapToDouble(Double::doubleValue).toArray();
                    double[] C = state.regimeCloses.stream().mapToDouble(Double::doubleValue).toArray();
                    MarketRegimeDetector.Regime[] regimes = MarketRegimeDetector.computeAll(
                            H, L, C,
                            regimeCfg.getAdxPeriod(), regimeCfg.getAtrPeriod(),
                            regimeCfg.getAdxTrendThreshold(),
                            regimeCfg.getAtrVolatilePct(), regimeCfg.getAtrCompressionPct());
                    MarketRegimeDetector.Regime last = regimes[sz - 1];
                    if (last != null) regime = last.name();
                }
            }

            // ── Day boundary reset for daily cap tracking ──────────────────
            LocalDate candleDay = candle.openTime() != null ? candle.openTime().toLocalDate() : null;
            if (riskOn) {
                for (String label : state.cooldowns.keySet()) {
                    DailyCapState dc = state.dailyCaps.get(label);
                    if (candleDay != null && !candleDay.equals(dc.date)) {
                        state.dailyCaps.put(label, new DailyCapState(candleDay, state.capitals.get(label), false));
                    }
                }
                if (candleDay != null && !candleDay.equals(state.combinedDailyCap.date)) {
                    state.combinedDailyCap = new DailyCapState(candleDay, state.combinedCapital, false);
                }
            }

            // ── Tick down cooldowns ────────────────────────────────────────────
            for (String label : state.cooldowns.keySet()) {
                int c = state.cooldowns.get(label); if (c > 0) state.cooldowns.put(label, c - 1);
                int rc = state.revCooldowns.get(label); if (rc > 0) state.revCooldowns.put(label, rc - 1);
            }
            if (state.combinedRevCooldown > 0) state.combinedRevCooldown--;

            // ── Per-candle mutable lists ───────────────────────────────────────
            List<ActionEntry>    actions         = new ArrayList<>();
            List<BlockedSignal>  blockedSignals  = new ArrayList<>();
            List<CombinedDetail> combinedDetails = new ArrayList<>();
            Map<String, String>  signals         = new LinkedHashMap<>();
            Map<String, String>  candleClosedDir = new HashMap<>();

            // ── SL/TP check for individual positions ──────────────────────────
            for (StrategyConfig cfg : stratCfgs) {
                String        label = resolveLabel(cfg);
                PositionState pos   = state.positions.get(label);
                if (pos == null || !riskOn) continue;

                String exitReason = null;
                double exitPrice  = 0;
                if (pos.type == PositionDirection.LONG) {
                    if (pos.slPrice != null && cL <= pos.slPrice) { exitPrice = pos.slPrice; exitReason = "STOP_LOSS"; }
                    else if (pos.tpPrice != null && cH >= pos.tpPrice) { exitPrice = pos.tpPrice; exitReason = "TAKE_PROFIT"; }
                } else if (pos.type == PositionDirection.SHORT) {
                    if (pos.slPrice != null && cH >= pos.slPrice) { exitPrice = pos.slPrice; exitReason = "STOP_LOSS"; }
                    else if (pos.tpPrice != null && cL <= pos.tpPrice) { exitPrice = pos.tpPrice; exitReason = "TAKE_PROFIT"; }
                }
                if (exitReason != null) {
                    ClosedTrade ct = closePosition(label, pos, exitPrice, candleTime, exitReason, regime, state);
                    state.positions.put(label, null);
                    String act = pos.type == PositionDirection.LONG ? "Exit Long" : "Exit Short";
                    String rsn = "STOP_LOSS".equals(exitReason) ? "Stop Loss hit" : "Take Profit hit";
                    actions.add(ActionEntry.builder().strategyLabel(label).action(act).reason(rsn)
                            .exitReason(exitReason).price(exitPrice).regime(regime).build());
                    if (riskOn && riskCfg.getCooldownCandles() > 0 && ct.getPnl() <= 0) {
                        state.cooldowns.put(label, riskCfg.getCooldownCandles());
                    }
                }
            }

            // ── SL/TP check for combined position ─────────────────────────────
            if (scoreOn && state.combinedPos != null && riskOn) {
                String exitReason = null;
                double exitPrice  = 0;
                if (state.combinedPos.type == PositionDirection.LONG) {
                    if (state.combinedPos.slPrice != null && cL <= state.combinedPos.slPrice) {
                        exitPrice = state.combinedPos.slPrice; exitReason = "STOP_LOSS";
                    } else if (state.combinedPos.tpPrice != null && cH >= state.combinedPos.tpPrice) {
                        exitPrice = state.combinedPos.tpPrice; exitReason = "TAKE_PROFIT";
                    }
                } else if (state.combinedPos.type == PositionDirection.SHORT) {
                    if (state.combinedPos.slPrice != null && cH >= state.combinedPos.slPrice) {
                        exitPrice = state.combinedPos.slPrice; exitReason = "STOP_LOSS";
                    } else if (state.combinedPos.tpPrice != null && cL <= state.combinedPos.tpPrice) {
                        exitPrice = state.combinedPos.tpPrice; exitReason = "TAKE_PROFIT";
                    }
                }
                if (exitReason != null) {
                    PositionState closedCombined = state.combinedPos;
                    ClosedTrade ct = closePositionDirect(closedCombined, exitPrice, candleTime, exitReason, regime,
                            state.combinedCapital, state.combinedTrades, state.combinedEquities);
                    state.combinedCapital = BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP);
                    state.combinedPos = null;
                    String act = closedCombined.type == PositionDirection.LONG ? "Exit Long" : "Exit Short";
                    String rsn = "STOP_LOSS".equals(exitReason) ? "Stop Loss hit" : "Take Profit hit";
                    combinedDetails.add(CombinedDetail.builder()
                            .action(act).reason(rsn).exitReason(exitReason)
                            .price(exitPrice).regime(regime).sourceStrategy(closedCombined.sourceStrategy)
                            .trigger("Risk Management").build());
                }
            }

            // ── Evaluate all strategies ────────────────────────────────────────
            for (StrategyConfig cfg : stratCfgs) {
                String label = resolveLabel(cfg);

                if (state.cooldowns.get(label) > 0) continue;

                // Daily cap check
                if (riskOn) {
                    DailyCapState dc = state.dailyCaps.get(label);
                    if (dc.halted) continue;
                    if (capFrac != null && dc.startCapital.compareTo(BigDecimal.ZERO) > 0) {
                        BigDecimal lost = dc.startCapital.subtract(state.capitals.get(label))
                                .divide(dc.startCapital, 8, RoundingMode.HALF_UP);
                        if (lost.compareTo(capFrac) >= 0) {
                            state.dailyCaps.put(label, new DailyCapState(dc.date, dc.startCapital, true));
                            continue;
                        }
                    }
                }

                // OPTION rule: disable SMA_CROSSOVER and BREAKOUT
                if (isOption && rulesOn && optionRules.isDisableSmaBreakout()) {
                    String st = cfg.getStrategyType();
                    if ("SMA_CROSSOVER".equals(st) || "BREAKOUT".equals(st)) continue;
                }

                // Regime filter
                if (regimeOn && regime != null && cfg.getActiveRegimes() != null && !cfg.getActiveRegimes().isEmpty()) {
                    if (!cfg.getActiveRegimes().contains(regime)) continue;
                }

                PositionState pos = state.positions.get(label);
                PositionDirection curDir = pos != null ? pos.type : PositionDirection.FLAT;
                boolean allowShorting = req.isAllowShorting();
                StrategyContext ctx = buildCtx(state.instanceIds.get(label), cfg, ic, resolvedQty, curDir, allowShorting, candle);
                StrategyResult  sr  = state.logicMap.get(label).evaluate(ctx);

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

                if (combinedOnlyMode) continue;

                boolean hasLong  = pos != null && pos.type == PositionDirection.LONG;
                boolean hasShort = pos != null && pos.type == PositionDirection.SHORT;
                boolean noSCR    = rulesOn && (isOption
                        ? optionRules.isNoSameCandleReversal()
                        : stockRules.isNoSameCandleReversal());

                StrategyScorer.ScoreResult scoreForGate = state.scorerMap.get(label)
                        .score(cfg.getStrategyType(), "BUY".equals(signal), regime, instrType);

                if ("BUY".equals(signal)) {
                    if (hasLong) {
                        blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                .price(cC).reason("Already in LONG position").build());
                    } else if (hasShort) {
                        if (noSCR && "SHORT".equals(candleClosedDir.get(label))) {
                            blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                    .price(cC).reason("Rule: No same-candle reversal (SHORT already closed)").build());
                            continue;
                        }
                        ClosedTrade ct = closePosition(label, pos, cC, candleTime, "SIGNAL", regime, state);
                        state.positions.put(label, null);
                        actions.add(ActionEntry.builder().strategyLabel(label).action("Exit Short")
                                .reason("Signal").exitReason("SIGNAL").price(cC).regime(regime).build());
                        candleClosedDir.put(label, "SHORT");
                        if (riskOn && riskCfg.getCooldownCandles() > 0 && ct.getPnl() <= 0) {
                            state.cooldowns.put(label, riskCfg.getCooldownCandles());
                        }
                        if (allowShorting) {
                            String gateBlock = longGateBlock(cC, regime, instrType, scoreForGate,
                                    state.revCooldowns.get(label), currentVwap, rulesOn, stockRules, isOption);
                            if (gateBlock == null) {
                                int qty = sizeQty(resolvedQty, state.capitals.get(label), cC, riskFrac, slFrac);
                                openPosition(label, PositionDirection.LONG, cC, qty, candleTime, regime, null,
                                        slFrac, tpFrac, state.positions, state.capitals);
                                state.revCooldowns.put(label, 2);
                                actions.add(ActionEntry.builder().strategyLabel(label).action("Enter Long")
                                        .reason("Reversal SHORT->LONG").price(cC).regime(regime).build());
                            } else {
                                blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                        .price(cC).reason(gateBlock).build());
                            }
                        }
                    } else {
                        String gateBlock = longGateBlock(cC, regime, instrType, scoreForGate,
                                state.revCooldowns.get(label), currentVwap, rulesOn, stockRules, isOption);
                        if (gateBlock == null) {
                            int qty = sizeQty(resolvedQty, state.capitals.get(label), cC, riskFrac, slFrac);
                            openPosition(label, PositionDirection.LONG, cC, qty, candleTime, regime, null,
                                    slFrac, tpFrac, state.positions, state.capitals);
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
                        if (noSCR && "LONG".equals(candleClosedDir.get(label))) {
                            blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                    .price(cC).reason("Rule: No same-candle reversal (LONG already closed)").build());
                            continue;
                        }
                        ClosedTrade ct = closePosition(label, pos, cC, candleTime, "SIGNAL", regime, state);
                        state.positions.put(label, null);
                        actions.add(ActionEntry.builder().strategyLabel(label).action("Exit Long")
                                .reason("Signal").exitReason("SIGNAL").price(cC).regime(regime).build());
                        candleClosedDir.put(label, "LONG");
                        if (riskOn && riskCfg.getCooldownCandles() > 0 && ct.getPnl() <= 0) {
                            state.cooldowns.put(label, riskCfg.getCooldownCandles());
                        }
                        if (allowShorting) {
                            int qty = sizeQty(resolvedQty, state.capitals.get(label), cC, riskFrac, slFrac);
                            openPosition(label, PositionDirection.SHORT, cC, qty, candleTime, regime, null,
                                    slFrac, tpFrac, state.positions, state.capitals);
                            state.revCooldowns.put(label, 2);
                            actions.add(ActionEntry.builder().strategyLabel(label).action("Enter Short")
                                    .reason("Reversal LONG->SHORT").price(cC).regime(regime).build());
                        }
                    } else {
                        if (allowShorting) {
                            int qty = sizeQty(resolvedQty, state.capitals.get(label), cC, riskFrac, slFrac);
                            openPosition(label, PositionDirection.SHORT, cC, qty, candleTime, regime, null,
                                    slFrac, tpFrac, state.positions, state.capitals);
                            actions.add(ActionEntry.builder().strategyLabel(label).action("Enter Short")
                                    .reason("Signal").price(cC).regime(regime).build());
                        } else {
                            blockedSignals.add(BlockedSignal.builder().strategy(label).signal(signal)
                                    .price(cC).reason("Shorting disabled — no open LONG to exit").build());
                        }
                    }
                }
            } // end per-strategy loop

            // ── Combined pool ──────────────────────────────────────────────────
            if (scoreOn) {
                boolean combinedBlocked = rulesOn && (
                        (!isOption && stockRules.isRangingNoTrade()   && "RANGING".equals(regime)) ||
                        (isOption  && optionRules.isVolatileNoTrade() && "VOLATILE".equals(regime))
                );

                String bestLabel  = null;
                String bestSignal = null;
                StrategyScorer.ScoreResult bestScore = null;

                if (!combinedBlocked) {
                    for (StrategyConfig cfg : stratCfgs) {
                        String lbl = resolveLabel(cfg);
                        if (isOption && rulesOn && optionRules.isDisableSmaBreakout()) {
                            String st = cfg.getStrategyType();
                            if ("SMA_CROSSOVER".equals(st) || "BREAKOUT".equals(st)) continue;
                        }
                        if (!isOption && rulesOn && stockRules.isCompressionShortOnly() && "COMPRESSION".equals(regime)) {
                            if ("BUY".equals(signals.get(lbl))) continue;
                        }
                        String sig = signals.get(lbl);
                        if (sig == null || "HOLD".equals(sig)) continue;

                        boolean isBuy = "BUY".equals(sig);
                        StrategyScorer.ScoreResult sc = state.combinedScorer.score(
                                cfg.getStrategyType(), isBuy, regime, instrType);

                        if (isOption && rulesOn && optionRules.isDistrustHighVolScore()) {
                            if (sc.getVolatilityScore() > optionRules.getVolScoreMax()) continue;
                        }
                        if (sc.getTotal() < minScore) continue;
                        if (bestScore == null || sc.getTotal() > bestScore.getTotal()) {
                            bestScore = sc; bestLabel = lbl; bestSignal = sig;
                        }
                    }
                }

                if (bestLabel != null) {
                    boolean isBuyBest = "BUY".equals(bestSignal);
                    boolean cHasLong  = state.combinedPos != null && state.combinedPos.type == PositionDirection.LONG;
                    boolean cHasShort = state.combinedPos != null && state.combinedPos.type == PositionDirection.SHORT;
                    boolean noSCR     = rulesOn && (isOption
                            ? optionRules.isNoSameCandleReversal()
                            : stockRules.isNoSameCandleReversal());
                    boolean bestAllowShort = req.isAllowShorting();

                    String trigger = buildTrigger(bestScore);
                    final StrategyScorer.ScoreResult finalBestScore = bestScore;
                    final String finalBestLabel = bestLabel;

                    if (isBuyBest) {
                        if (cHasShort) {
                            if (!(noSCR && "SHORT".equals(candleClosedDir.get(COMBINED_LABEL)))) {
                                boolean passesGate = combinedLongGateCheck(cC, regime, instrType, finalBestScore,
                                        state.combinedRevCooldown, currentVwap, rulesOn, stockRules, isOption);
                                ClosedTrade ct = closePositionDirect(state.combinedPos, cC, candleTime, "SIGNAL", regime,
                                        state.combinedCapital, state.combinedTrades, state.combinedEquities);
                                state.combinedCapital = BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP);
                                state.combinedPos = null;
                                candleClosedDir.put(COMBINED_LABEL, "SHORT");
                                combinedDetails.add(CombinedDetail.builder()
                                        .action("Exit Short").reason("Signal").exitReason("SIGNAL")
                                        .price(cC).regime(regime).sourceStrategy(finalBestLabel).trigger(trigger)
                                        .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                                if (bestAllowShort && passesGate) {
                                    int qty = sizeQty(resolvedQty, state.combinedCapital, cC, riskFrac, slFrac);
                                    state.combinedPos = buildPosition(PositionDirection.LONG, cC, qty, candleTime,
                                            regime, finalBestLabel, slFrac, tpFrac);
                                    state.combinedRevCooldown = 2;
                                    combinedDetails.add(CombinedDetail.builder()
                                            .action("Enter Long").reason("Reversal SHORT->LONG")
                                            .price(cC).regime(regime).sourceStrategy(finalBestLabel).trigger(trigger)
                                            .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                                }
                            }
                        } else if (!cHasLong) {
                            boolean passesGate = combinedLongGateCheck(cC, regime, instrType, finalBestScore,
                                    state.combinedRevCooldown, currentVwap, rulesOn, stockRules, isOption);
                            if (passesGate) {
                                int qty = sizeQty(resolvedQty, state.combinedCapital, cC, riskFrac, slFrac);
                                state.combinedPos = buildPosition(PositionDirection.LONG, cC, qty, candleTime,
                                        regime, finalBestLabel, slFrac, tpFrac);
                                combinedDetails.add(CombinedDetail.builder()
                                        .action("Enter Long").reason("Signal")
                                        .price(cC).regime(regime).sourceStrategy(finalBestLabel).trigger(trigger)
                                        .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                            }
                        }
                    } else { // SELL
                        if (cHasLong) {
                            if (!(noSCR && "LONG".equals(candleClosedDir.get(COMBINED_LABEL)))) {
                                ClosedTrade ct = closePositionDirect(state.combinedPos, cC, candleTime, "SIGNAL", regime,
                                        state.combinedCapital, state.combinedTrades, state.combinedEquities);
                                state.combinedCapital = BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP);
                                state.combinedPos = null;
                                candleClosedDir.put(COMBINED_LABEL, "LONG");
                                combinedDetails.add(CombinedDetail.builder()
                                        .action("Exit Long").reason("Signal").exitReason("SIGNAL")
                                        .price(cC).regime(regime).sourceStrategy(finalBestLabel).trigger(trigger)
                                        .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                                if (bestAllowShort) {
                                    int qty = sizeQty(resolvedQty, state.combinedCapital, cC, riskFrac, slFrac);
                                    state.combinedPos = buildPosition(PositionDirection.SHORT, cC, qty, candleTime,
                                            regime, finalBestLabel, slFrac, tpFrac);
                                    state.combinedRevCooldown = 2;
                                    combinedDetails.add(CombinedDetail.builder()
                                            .action("Enter Short").reason("Reversal LONG->SHORT")
                                            .price(cC).regime(regime).sourceStrategy(finalBestLabel).trigger(trigger)
                                            .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                                }
                            }
                        } else if (!cHasShort && bestAllowShort) {
                            int qty = sizeQty(resolvedQty, state.combinedCapital, cC, riskFrac, slFrac);
                            state.combinedPos = buildPosition(PositionDirection.SHORT, cC, qty, candleTime,
                                    regime, finalBestLabel, slFrac, tpFrac);
                            combinedDetails.add(CombinedDetail.builder()
                                    .action("Enter Short").reason("Signal")
                                    .price(cC).regime(regime).sourceStrategy(finalBestLabel).trigger(trigger)
                                    .score(ReplayCandleEvent.toScoreDetail(finalBestScore)).build());
                        }
                    }
                }
            } // end combined pool

            // ── Fill HOLD signals for skipped strategies ───────────────────────
            for (StrategyConfig cfg : stratCfgs) {
                signals.putIfAbsent(resolveLabel(cfg), "HOLD");
            }

            // ── Build strategyStates snapshot ─────────────────────────────────
            Map<String, StrategyState> stratStateMap = new LinkedHashMap<>();
            for (StrategyConfig cfg : stratCfgs) {
                String label = resolveLabel(cfg);
                stratStateMap.put(label, buildStrategyState(
                        state.capitals.get(label), state.positions.get(label),
                        state.trades.get(label), state.equities.get(label)));
            }
            if (scoreOn) {
                stratStateMap.put(COMBINED_LABEL, buildStrategyState(
                        state.combinedCapital, state.combinedPos,
                        state.combinedTrades, state.combinedEquities));
            }

            // ── Emit SSE event ─────────────────────────────────────────────────
            int emitted = emittedByToken.merge(token, 1, Integer::sum);

            ReplayCandleEvent event = ReplayCandleEvent.builder()
                    .candleTime(candleTime)
                    .open(cO).high(cH).low(cL).close(cC).volume(cV)
                    .regime(regime)
                    .signals(signals)
                    .actions(actions)
                    .blockedSignals(blockedSignals)
                    .combinedDetails(combinedDetails)
                    .strategyStates(stratStateMap)
                    .emitted(emitted)
                    .total(0)  // live — no fixed total
                    .build();

            try {
                Map<String, Object> envelope = new LinkedHashMap<>();
                envelope.put("instrumentToken", token);
                envelope.put("symbol", ic.getSymbol());
                envelope.put("candle", event);
                String json = objectMapper.writeValueAsString(envelope);
                emitter.send(SseEmitter.event().name("candle").data(json));
            } catch (Exception e) {
                log.warn("Live eval session {}: SSE emit failed for {} — client likely disconnected",
                        sessionId, ic.getSymbol());
                stopped = true;
            }
        }

        void stop() {
            stopped = true;
            if (tickFuture != null) tickFuture.cancel(true);
            for (InstrEvalState state : evalStates.values()) {
                for (Map.Entry<String, String> e : state.instanceIds.entrySet()) {
                    StrategyLogic logic = state.logicMap.get(e.getKey());
                    if (logic != null) {
                        try { logic.onInstanceRemoved(e.getValue()); } catch (Exception ignored) {}
                    }
                }
            }
            try { emitter.complete(); } catch (Exception ignored) {}
        }

        // ── Per-session helper methods (need access to session fields) ─────────

        StrategyContext buildCtx(String instanceId, StrategyConfig cfg, InstrumentConfig ic,
                                 int qty, PositionDirection dir, boolean allowShort, CandleDto candle) {
            return StrategyContext.builder()
                    .instanceId(instanceId)
                    .strategyType(cfg.getStrategyType())
                    .userId(req.getUserId())
                    .brokerName(req.getBrokerName())
                    .symbol(ic.getSymbol().toUpperCase())
                    .exchange(ic.getExchange().toUpperCase())
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

        PositionState openPosition(String label, PositionDirection type, double price, int qty,
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

        PositionState buildPosition(PositionDirection type, double price, int qty,
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

        ClosedTrade closePosition(String label, PositionState pos, double exitPrice,
                                  String exitTime, String exitReason, String regime,
                                  InstrEvalState state) {
            ClosedTrade ct = closePositionDirect(pos, exitPrice, exitTime, exitReason, regime,
                    state.capitals.get(label), state.trades.get(label), state.equities.get(label));
            state.capitals.put(label, BigDecimal.valueOf(ct.getCapitalAfter()).setScale(2, RoundingMode.HALF_UP));
            return ct;
        }

        ClosedTrade closePositionDirect(PositionState pos, double exitPrice,
                                        String exitTime, String exitReason, String regime,
                                        BigDecimal capitalBefore,
                                        List<ClosedTrade> tradeList,
                                        List<EquityPoint> equityList) {
            double pnl = pos.type == PositionDirection.SHORT
                    ? (pos.entryPrice - exitPrice) * pos.qty
                    : (exitPrice - pos.entryPrice) * pos.qty;
            double capitalAfter = capitalBefore.doubleValue() + pnl;
            double notional = pos.entryPrice * pos.qty;
            double pnlPct   = notional > 0 ? (pnl / notional) * 100.0 : 0.0;

            ClosedTrade ct = ClosedTrade.builder()
                    .type(pos.type.name()).entryTime(pos.entryTime).exitTime(exitTime)
                    .exitReason(exitReason).regime(regime).sourceStrategy(pos.sourceStrategy)
                    .entryPrice(pos.entryPrice).exitPrice(exitPrice)
                    .pnl(Math.round(pnl * 100.0) / 100.0)
                    .pnlPct(Math.round(pnlPct * 100.0) / 100.0)
                    .capitalAfter(Math.round(capitalAfter * 100.0) / 100.0)
                    .qty(pos.qty).build();

            tradeList.add(ct);
            equityList.add(EquityPoint.builder().time(exitTime).capital(capitalAfter).build());
            return ct;
        }

        StrategyState buildStrategyState(BigDecimal capital, PositionState pos,
                                         List<ClosedTrade> trades, List<EquityPoint> equity) {
            OpenPosition openPos = null;
            if (pos != null) {
                openPos = OpenPosition.builder()
                        .type(pos.type.name()).entryPrice(pos.entryPrice).qty(pos.qty)
                        .entryTime(pos.entryTime).slPrice(pos.slPrice).tpPrice(pos.tpPrice)
                        .regime(pos.regime).sourceStrategy(pos.sourceStrategy).build();
            }
            return StrategyState.builder()
                    .capital(capital.doubleValue())
                    .openPosition(openPos)
                    .closedTrades(new ArrayList<>(trades))
                    .equityHistory(new ArrayList<>(equity))
                    .build();
        }

        String longGateBlock(double price, String regime, String instrType,
                              StrategyScorer.ScoreResult score, int revCooldown, double vwap,
                              boolean rulesOn, StockRules stockRules, boolean isOption) {
            if (isOption || !rulesOn) return null;
            LongQualityGate gate = stockRules.getLongQualityGate();
            if (gate == null || !gate.isEnabled()) return null;
            if (score.getTotal() < gate.getScoreMin()) {
                return String.format("Rule: LONG gate — score %.1f < %.0f", score.getTotal(), gate.getScoreMin());
            }
            if (revCooldown > 0) return "Rule: LONG gate — reversal cooldown active";
            if (vwap > 0) {
                double extPct = Math.abs(price - vwap) / vwap * 100.0;
                if (extPct > gate.getVwapMaxPct()) {
                    return String.format("Rule: LONG gate — price %.2f%% from VWAP (max %.1f%%)", extPct, gate.getVwapMaxPct());
                }
            }
            return null;
        }

        boolean combinedLongGateCheck(double price, String regime, String instrType,
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

        int sizeQty(int resolvedQty, BigDecimal capital, double entryPrice,
                    BigDecimal riskFrac, BigDecimal slFrac) {
            if (riskFrac == null || slFrac == null || slFrac.compareTo(BigDecimal.ZERO) == 0) return resolvedQty;
            double riskAmount = capital.doubleValue() * riskFrac.doubleValue();
            double slAmount   = entryPrice * slFrac.doubleValue();
            if (slAmount <= 0) return resolvedQty;
            return Math.max(1, (int) Math.floor(riskAmount / slAmount));
        }

    } // end LiveSession

    // ─── InstrEvalState ───────────────────────────────────────────────────────

    /** All per-instrument mutable evaluation state for a live session. */
    private static class InstrEvalState {

        final Map<String, String>         instanceIds;
        final Map<String, StrategyLogic>  logicMap;
        final Map<String, StrategyScorer> scorerMap;
        final StrategyScorer              combinedScorer;

        final Map<String, PositionState>          positions;
        final Map<String, BigDecimal>             capitals;
        final Map<String, List<ClosedTrade>>      trades;
        final Map<String, List<EquityPoint>>      equities;
        final Map<String, Integer>                cooldowns;
        final Map<String, Integer>                revCooldowns;
        final Map<String, DailyCapState>          dailyCaps;

        PositionState     combinedPos     = null;
        BigDecimal        combinedCapital;
        List<ClosedTrade> combinedTrades  = new ArrayList<>();
        List<EquityPoint> combinedEquities;
        int               combinedRevCooldown = 0;
        DailyCapState     combinedDailyCap;

        // Pattern state
        double[]    patPrev2    = null;
        double[]    patPrev1    = null;
        final double pMinWick;
        final double pMaxBody;
        final Set<String> buyConfirm;
        final Set<String> sellConfirm;

        // VWAP
        LocalDate vwapDay   = null;
        double    vwapSumTV = 0.0;
        double    vwapSumV  = 0.0;

        // Regime rolling history (kept bounded in session)
        final List<Double> regimeHighs  = new ArrayList<>();
        final List<Double> regimeLows   = new ArrayList<>();
        final List<Double> regimeCloses = new ArrayList<>();

        InstrEvalState(InstrumentConfig ic, List<StrategyConfig> stratCfgs, BigDecimal initCap,
                       boolean patternOn, PatternConfig patCfg) {

            // Maps are allocated here; instanceIds/logicMap/scorerMap are populated
            // by the enclosing LiveSession.run() which has access to strategyRegistry.
            instanceIds = new LinkedHashMap<>();
            logicMap    = new LinkedHashMap<>();
            scorerMap   = new LinkedHashMap<>();

            positions    = new LinkedHashMap<>();
            capitals     = new LinkedHashMap<>();
            trades       = new LinkedHashMap<>();
            equities     = new LinkedHashMap<>();
            cooldowns    = new LinkedHashMap<>();
            revCooldowns = new LinkedHashMap<>();
            dailyCaps    = new LinkedHashMap<>();

            for (StrategyConfig cfg : stratCfgs) {
                String label = resolveLabel(cfg);
                positions.put(label, null);
                capitals.put(label, initCap);
                trades.put(label, new ArrayList<>());
                equities.put(label, new ArrayList<>(List.of(
                        EquityPoint.builder().time("start").capital(initCap.doubleValue()).build())));
                cooldowns.put(label, 0);
                revCooldowns.put(label, 0);
                dailyCaps.put(label, new DailyCapState(null, initCap, false));
            }

            combinedScorer   = new StrategyScorer();
            combinedCapital  = initCap;
            combinedEquities = new ArrayList<>(List.of(
                    EquityPoint.builder().time("start").capital(initCap.doubleValue()).build()));
            combinedDailyCap = new DailyCapState(null, initCap, false);

            pMinWick    = patternOn ? patCfg.getMinWickRatio() : 2.0;
            pMaxBody    = patternOn ? patCfg.getMaxBodyPct()   : 0.35;
            buyConfirm  = patternOn && patCfg.getBuyConfirmPatterns() != null
                    ? new HashSet<>(patCfg.getBuyConfirmPatterns())  : Set.of();
            sellConfirm = patternOn && patCfg.getSellConfirmPatterns() != null
                    ? new HashSet<>(patCfg.getSellConfirmPatterns()) : Set.of();
        }
    }

    // ─── FormingCandle ────────────────────────────────────────────────────────

    private static class FormingCandle {
        double open, high, low, close;
        long   volume;
        long   startTime;

        FormingCandle(double open, double high, double low, double close, long volume, long startTime) {
            this.open = open; this.high = high; this.low = low; this.close = close;
            this.volume = volume; this.startTime = startTime;
        }

        CandleDto toClosedCandle(long bucketStartMs) {
            LocalDateTime openTime = LocalDateTime.ofInstant(
                    Instant.ofEpochMilli(bucketStartMs), ZoneOffset.UTC);
            return new CandleDto(openTime,
                    BigDecimal.valueOf(open), BigDecimal.valueOf(high),
                    BigDecimal.valueOf(low),  BigDecimal.valueOf(close),
                    volume);
        }
    }

    // ─── Static inner state classes ───────────────────────────────────────────

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
            this.type = type; this.entryPrice = entryPrice; this.qty = qty;
            this.entryTime = entryTime; this.regime = regime;
            this.sourceStrategy = sourceStrategy;
            this.slPrice = slPrice; this.tpPrice = tpPrice;
        }
    }

    private static final class DailyCapState {
        final LocalDate  date;
        final BigDecimal startCapital;
        final boolean    halted;

        DailyCapState(LocalDate date, BigDecimal startCapital, boolean halted) {
            this.date = date; this.startCapital = startCapital; this.halted = halted;
        }
    }

    // ─── Static utilities ─────────────────────────────────────────────────────

    private static String resolveLabel(StrategyConfig cfg) {
        return (cfg.getLabel() != null && !cfg.getLabel().isBlank())
                ? cfg.getLabel() : cfg.getStrategyType();
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
}
