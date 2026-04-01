package com.sma.strategyengine.service.options;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.request.OptionsLiveRequest;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.model.response.OptionsReplayCandleEvent;
import com.sma.strategyengine.service.MarketRegimeDetector;
import com.sma.strategyengine.strategy.StrategyRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;

/**
 * Live NIFTY-driven options evaluation service.
 *
 * <p>Each session:
 * <ol>
 *   <li>Pre-warms the NiftyDecisionEngine with recent NIFTY candles from Data Engine.</li>
 *   <li>Subscribes to the Data Engine tick SSE stream (same as LiveEvalService).</li>
 *   <li>Forms candles from ticks per the configured interval — one candle per bucket per token.</li>
 *   <li>On each NIFTY candle close, runs the full decision + execution pipeline.</li>
 *   <li>Emits {@link OptionsReplayCandleEvent} objects via SSE — same format as replay.</li>
 * </ol>
 *
 * <p>Option candle data is built incrementally from the tick stream and stored in a
 * live-growing {@link NavigableMap} per token.  When a NIFTY candle closes the service
 * snapshots the current forming state of each option candle so that the
 * {@link OptionSelectorService} always has the most current option prices.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OptionsLiveService {

    private final StrategyRegistry  strategyRegistry;
    private final DataEngineClient  dataEngineClient;
    private final ObjectMapper      objectMapper;

    @Value("${strategy.data-engine.base-url:http://localhost:9005}")
    private String dataEngineBaseUrl;

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private static final Map<String, Long> INTERVAL_MS = Map.of(
            "MINUTE_1",   60_000L,
            "MINUTE_3",  180_000L,
            "MINUTE_5",  300_000L,
            "MINUTE_10", 600_000L,
            "MINUTE_15", 900_000L,
            "MINUTE_30", 1_800_000L,
            "MINUTE_60", 3_600_000L,
            "DAY",       86_400_000L
    );

    private final ConcurrentHashMap<String, LiveOptionsSession> sessions = new ConcurrentHashMap<>();

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "opts-live-" + System.nanoTime());
        t.setDaemon(true);
        return t;
    });

    // ── Public API ────────────────────────────────────────────────────────────

    public String start(OptionsLiveRequest req, SseEmitter emitter) {
        String sessionId = UUID.randomUUID().toString();
        LiveOptionsSession session = new LiveOptionsSession(sessionId, req, emitter);
        sessions.put(sessionId, session);

        emitter.onCompletion(() -> cleanup(sessionId));
        emitter.onError(e -> cleanup(sessionId));

        executor.execute(() -> {
            try {
                session.run();
            } catch (Exception e) {
                log.error("Options live session {} failed: {}", sessionId, e.getMessage(), e);
                cleanup(sessionId);
                try { emitter.completeWithError(e); } catch (Exception ignored) {}
            }
        });

        log.info("Options live session {} started: interval={}, CE={}, PE={}",
                sessionId, req.getInterval(),
                req.getCeOptions() != null ? req.getCeOptions().size() : 0,
                req.getPeOptions() != null ? req.getPeOptions().size() : 0);
        return sessionId;
    }

    public SseEmitter getEmitter(String sessionId) {
        LiveOptionsSession s = sessions.get(sessionId);
        return s != null ? s.emitter : null;
    }

    public void stop(String sessionId) {
        cleanup(sessionId);
        log.info("Options live session {} stopped", sessionId);
    }

    private void cleanup(String sessionId) {
        LiveOptionsSession session = sessions.remove(sessionId);
        if (session != null) session.stop();
    }

    // ── FormingCandle ─────────────────────────────────────────────────────────

    static class FormingCandle {
        double open, high, low, close;
        long   volume;
        long   startMs; // bucket start epoch-ms

        FormingCandle(double price, long volume, long startMs) {
            this.open = this.high = this.low = this.close = price;
            this.volume  = volume;
            this.startMs = startMs;
        }

        void update(double price, long volume) {
            this.high   = Math.max(this.high, price);
            this.low    = Math.min(this.low,  price);
            this.close  = price;
            this.volume = volume;
        }

        CandleDto toCandle(LocalDateTime openTime) {
            return new CandleDto(openTime,
                    BigDecimal.valueOf(open),  BigDecimal.valueOf(high),
                    BigDecimal.valueOf(low),   BigDecimal.valueOf(close),
                    volume);
        }
    }

    // ── LiveOptionsSession ────────────────────────────────────────────────────

    private class LiveOptionsSession {

        final String              sessionId;
        final OptionsLiveRequest  req;
        final SseEmitter          emitter;
        final long                ivMs;

        // Instrument sets
        final long        niftyToken;
        final Set<Long>   optionTokens = new HashSet<>();

        // All forming candles keyed by token
        final Map<Long, FormingCandle> forming = new HashMap<>();

        // Live option candle history: token -> sorted(openTime -> candle)
        // Passed by reference to OptionSelectorService so new candles are visible immediately.
        final Map<Long, NavigableMap<LocalDateTime, CandleDto>> liveOptionCandles = new HashMap<>();

        // Regime rolling buffers (NIFTY only)
        final List<Double> regimeHighs  = new ArrayList<>();
        final List<Double> regimeLows   = new ArrayList<>();
        final List<Double> regimeCloses = new ArrayList<>();

        // Engines — initialised after warmup
        NiftyDecisionEngine   decisionEngine;
        OptionSelectorService selectorService;
        OptionExecutionEngine execEngine;

        // CE / PE pools for execution engine
        final List<OptionsReplayRequest.OptionCandidate> cePool;
        final List<OptionsReplayRequest.OptionCandidate> pePool;

        int emittedCount = 0;

        volatile boolean   stopped    = false;
        volatile Future<?> tickFuture = null;

        // ── constructor ───────────────────────────────────────────────────────

        LiveOptionsSession(String sessionId, OptionsLiveRequest req, SseEmitter emitter) {
            this.sessionId = sessionId;
            this.req       = req;
            this.emitter   = emitter;
            this.ivMs      = INTERVAL_MS.getOrDefault(req.getInterval(), 300_000L);
            this.niftyToken = req.getNiftyInstrumentToken() != null
                    ? req.getNiftyInstrumentToken() : -1L;

            List<OptionsReplayRequest.OptionCandidate> ce =
                    req.getCeOptions() != null ? req.getCeOptions() : List.of();
            List<OptionsReplayRequest.OptionCandidate> pe =
                    req.getPeOptions() != null ? req.getPeOptions() : List.of();
            cePool = ce;
            pePool = pe;

            for (OptionsReplayRequest.OptionCandidate c : ce) {
                if (c.getInstrumentToken() != null) optionTokens.add(c.getInstrumentToken());
            }
            for (OptionsReplayRequest.OptionCandidate c : pe) {
                if (c.getInstrumentToken() != null) optionTokens.add(c.getInstrumentToken());
            }
            // Initialise a sorted-map slot per option token so the selector finds the map
            for (Long token : optionTokens) {
                liveOptionCandles.put(token, new TreeMap<>());
            }
        }

        // ── run ───────────────────────────────────────────────────────────────

        void run() throws Exception {
            // Phase 1: warm up NIFTY decision engine
            List<CandleDto> warmupCandles = List.of();
            if (req.getWarmupDays() > 0 && niftyToken > 0) {
                try {
                    LocalDateTime warmupTo   = LocalDateTime.now(IST);
                    LocalDateTime warmupFrom = warmupTo
                            .minusDays((long) req.getWarmupDays() + 7)
                            .withHour(9).withMinute(15).withSecond(0).withNano(0);

                    warmupCandles = dataEngineClient.fetchHistory(
                            new DataEngineClient.HistoryRequest(
                                    req.getUserId(), req.getBrokerName(),
                                    req.getApiKey(), req.getAccessToken(),
                                    req.getNiftyInstrumentToken(),
                                    req.getNiftySymbol(), req.getNiftyExchange(),
                                    req.getInterval(), warmupFrom, warmupTo, false));

                    log.info("Options live session {}: loaded {} warmup candles",
                            sessionId, warmupCandles.size());

                    // Populate regime rolling buffers
                    for (CandleDto c : warmupCandles) {
                        regimeHighs.add(c.high().doubleValue());
                        regimeLows.add(c.low().doubleValue());
                        regimeCloses.add(c.close().doubleValue());
                    }
                    keepRegimeBufferBounded();

                } catch (Exception e) {
                    log.warn("Options live session {}: warmup fetch failed (continuing): {}",
                            sessionId, e.getMessage());
                }
            }

            // Initialise engines (with or without warmup candles)
            initEngines();

            if (!warmupCandles.isEmpty()) {
                decisionEngine.warmup(warmupCandles);
            }

            // Emit init event
            emitter.send(SseEmitter.event().name("init").data(
                    objectMapper.writeValueAsString(Map.of(
                            "sessionId",     sessionId,
                            "warmupCandles", warmupCandles.size(),
                            "ceOptions",     cePool.size(),
                            "peOptions",     pePool.size()))));

            // Phase 2: subscribe to tick SSE
            if (!stopped) {
                tickFuture = executor.submit(this::readTickStream);
            }
        }

        // ── engine initialisation ─────────────────────────────────────────────

        void initEngines() {
            OptionsReplayRequest.DecisionConfig dc =
                    Optional.ofNullable(req.getDecisionConfig()).orElse(new OptionsReplayRequest.DecisionConfig());
            OptionsReplayRequest.SwitchConfig sc =
                    Optional.ofNullable(req.getSwitchConfig()).orElse(new OptionsReplayRequest.SwitchConfig());
            OptionsReplayRequest.SelectionConfig sel =
                    Optional.ofNullable(req.getSelectionConfig()).orElse(new OptionsReplayRequest.SelectionConfig());
            OptionsReplayRequest.RegimeRules rr =
                    Optional.ofNullable(req.getRegimeRules()).orElse(new OptionsReplayRequest.RegimeRules());
            OptionsReplayRequest.RegimeStrategyRules rsr =
                    Optional.ofNullable(req.getRegimeStrategyRules()).orElse(new OptionsReplayRequest.RegimeStrategyRules());
            OptionsReplayRequest.ChopRules cr =
                    Optional.ofNullable(req.getChopRules()).orElse(new OptionsReplayRequest.ChopRules());
            OptionsReplayRequest.RangeQualityConfig rqc =
                    Optional.ofNullable(req.getRangeQualityConfig()).orElse(new OptionsReplayRequest.RangeQualityConfig());
            OptionsReplayRequest.TradeQualityConfig tqc =
                    Optional.ofNullable(req.getTradeQualityConfig()).orElse(new OptionsReplayRequest.TradeQualityConfig());
            OptionsReplayRequest.TrendEntryConfig tec =
                    Optional.ofNullable(req.getTrendEntryConfig()).orElse(new OptionsReplayRequest.TrendEntryConfig());
            OptionsReplayRequest.CompressionEntryConfig cec =
                    Optional.ofNullable(req.getCompressionEntryConfig()).orElse(new OptionsReplayRequest.CompressionEntryConfig());

            decisionEngine  = new NiftyDecisionEngine(
                    strategyRegistry, req.getStrategies(), dc, sc, rr, rsr, cr, rqc, tqc, tec, cec);

            // Pass live map by reference — new candles added to liveOptionCandles are visible immediately
            selectorService = new OptionSelectorService(sel, liveOptionCandles);

            // Build a minimal OptionsReplayRequest to satisfy OptionExecutionEngine's constructor
            execEngine = new OptionExecutionEngine(buildExecRequest());
        }

        /** Builds the minimal OptionsReplayRequest fields needed by OptionExecutionEngine. */
        private OptionsReplayRequest buildExecRequest() {
            OptionsReplayRequest r = new OptionsReplayRequest();
            r.setInitialCapital(req.getInitialCapital());
            r.setQuantity(req.getQuantity());
            r.setDecisionConfig(req.getDecisionConfig() != null
                    ? req.getDecisionConfig() : new OptionsReplayRequest.DecisionConfig());
            r.setSwitchConfig(req.getSwitchConfig() != null
                    ? req.getSwitchConfig() : new OptionsReplayRequest.SwitchConfig());
            r.setHoldConfig(req.getHoldConfig() != null
                    ? req.getHoldConfig() : new OptionsReplayRequest.HoldConfig());
            r.setRiskConfig(req.getRiskConfig() != null
                    ? req.getRiskConfig() : new OptionsReplayRequest.RiskConfig());
            r.setExitConfig(req.getExitConfig() != null
                    ? req.getExitConfig() : new OptionsReplayRequest.ExitConfig());
            return r;
        }

        // ── tick stream ───────────────────────────────────────────────────────

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
                        String eventName  = null;
                        StringBuilder buf = new StringBuilder();

                        while (!stopped && (line = reader.readLine()) != null) {
                            if (line.startsWith("event:")) {
                                eventName = line.substring(6).trim();
                            } else if (line.startsWith("data:")) {
                                buf.append(line.substring(5).trim());
                            } else if (line.isEmpty()) {
                                if ("tick".equals(eventName) && buf.length() > 0) {
                                    processTickJson(buf.toString());
                                }
                                eventName = null;
                                buf.setLength(0);
                            }
                        }
                    }

                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    if (!stopped) {
                        log.warn("Options live session {}: tick stream error, reconnecting in 3s: {}",
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

                // Ignore replay ticks
                if (Boolean.TRUE.equals(tick.get("replay"))) return;

                Object tokenObj = tick.get("instrumentToken");
                if (tokenObj == null) return;
                long token = ((Number) tokenObj).longValue();

                if (token != niftyToken && !optionTokens.contains(token)) return;

                Object ltpObj = tick.get("ltp");
                if (ltpObj == null) return;
                double ltp = ((Number) ltpObj).doubleValue();

                Object volObj = tick.get("volume");
                long volumeToday = volObj != null ? ((Number) volObj).longValue() : 0L;

                long epochMs = System.currentTimeMillis();
                Object tsObj = tick.get("timestamp");
                if (tsObj instanceof String tsStr && !tsStr.isEmpty() && !"null".equals(tsStr)) {
                    try { epochMs = Instant.parse(tsStr).toEpochMilli(); } catch (Exception ignored) {}
                }

                processTick(token, ltp, volumeToday, epochMs);

            } catch (Exception e) {
                log.debug("Options live session {}: failed to parse tick: {}", sessionId, e.getMessage());
            }
        }

        // ── candle forming ────────────────────────────────────────────────────

        void processTick(long token, double ltp, long volumeToday, long epochMs) {
            if (stopped) return;
            long bucketMs = (epochMs / ivMs) * ivMs;

            if (token == niftyToken) {
                processNiftyTick(ltp, volumeToday, bucketMs);
            } else {
                processOptionTick(token, ltp, volumeToday, bucketMs);
            }
        }

        private void processNiftyTick(double ltp, long volumeToday, long bucketMs) {
            FormingCandle cur = forming.get(niftyToken);
            if (cur == null) {
                forming.put(niftyToken, new FormingCandle(ltp, volumeToday, bucketMs));
            } else if (bucketMs > cur.startMs) {
                CandleDto closed = cur.toCandle(bucketToLocalDateTime(cur.startMs));
                forming.put(niftyToken, new FormingCandle(ltp, volumeToday, bucketMs));
                // Snapshot option prices at the moment the NIFTY candle closed
                snapshotOptionCandles(cur.startMs, closed.openTime());
                onNiftyCandleClose(closed);
            } else {
                cur.update(ltp, volumeToday);
            }
        }

        private void processOptionTick(long token, double ltp, long volumeToday, long bucketMs) {
            FormingCandle cur = forming.get(token);
            if (cur == null) {
                forming.put(token, new FormingCandle(ltp, volumeToday, bucketMs));
            } else if (bucketMs > cur.startMs) {
                // Option candle for the old bucket has closed
                CandleDto closed = cur.toCandle(bucketToLocalDateTime(cur.startMs));
                forming.put(token, new FormingCandle(ltp, volumeToday, bucketMs));
                NavigableMap<LocalDateTime, CandleDto> map = liveOptionCandles.get(token);
                if (map != null) map.put(closed.openTime(), closed);
            } else {
                cur.update(ltp, volumeToday);
            }
        }

        /**
         * When a NIFTY candle closes, snapshot the forming option candles at the same
         * bucket time so the selector has the freshest prices even if those option
         * candles haven't "naturally" closed yet.
         */
        private void snapshotOptionCandles(long closedBucketMs, LocalDateTime closedBucketTime) {
            for (Long token : optionTokens) {
                FormingCandle opt = forming.get(token);
                if (opt != null && opt.startMs == closedBucketMs) {
                    // Snapshot current state as a provisional closed candle
                    CandleDto snap = new CandleDto(
                            closedBucketTime,
                            BigDecimal.valueOf(opt.open),  BigDecimal.valueOf(opt.high),
                            BigDecimal.valueOf(opt.low),   BigDecimal.valueOf(opt.close),
                            opt.volume);
                    NavigableMap<LocalDateTime, CandleDto> map = liveOptionCandles.get(token);
                    if (map != null) map.put(snap.openTime(), snap);
                }
            }
        }

        // ── candle evaluation ─────────────────────────────────────────────────

        private void onNiftyCandleClose(CandleDto niftyCandle) {
            if (stopped || decisionEngine == null) return;

            // Update regime rolling buffers
            regimeHighs.add(niftyCandle.high().doubleValue());
            regimeLows.add(niftyCandle.low().doubleValue());
            regimeCloses.add(niftyCandle.close().doubleValue());
            keepRegimeBufferBounded();

            // Compute current regime
            String regime = computeRegime();

            // Decision
            NiftyDecisionResult decision = decisionEngine.evaluate(niftyCandle, regime);

            // Post-process decision with trading and quality rules
            applyTradingRules(decision, regime, req.getTradingRules());
            applyScoreTierRules(decision, regime,
                    req.getTradeQualityConfig(), execEngine.getBarsSinceLastLoss());

            // Execution
            double        niftyClose = niftyCandle.close().doubleValue();
            LocalDateTime candleTime = niftyCandle.openTime();
            String action = execEngine.process(decision, selectorService,
                    cePool, pePool, niftyClose, candleTime, niftyCandle);

            // Build and emit SSE candle event
            emittedCount++;
            OptionsReplayCandleEvent event = buildEvent(
                    emittedCount, niftyCandle, decision, execEngine, selectorService, candleTime, action);

            try {
                emitter.send(SseEmitter.event().name("candle")
                        .data(objectMapper.writeValueAsString(event)));
            } catch (Exception e) {
                log.warn("Options live session {}: failed to send candle event: {}",
                        sessionId, e.getMessage());
                stop();
            }
        }

        // ── regime detection ──────────────────────────────────────────────────

        private String computeRegime() {
            BacktestRequest.RegimeConfig rc = req.getRegimeConfig();
            if (rc == null || !rc.isEnabled()) return "RANGING";
            int minRequired = rc.getAdxPeriod() * 2 + 1;
            if (regimeHighs.size() < minRequired) return "RANGING";
            int sz = regimeHighs.size();
            double[] H = regimeHighs.stream().mapToDouble(Double::doubleValue).toArray();
            double[] L = regimeLows.stream().mapToDouble(Double::doubleValue).toArray();
            double[] C = regimeCloses.stream().mapToDouble(Double::doubleValue).toArray();
            MarketRegimeDetector.Regime[] regimes = MarketRegimeDetector.computeAll(
                    H, L, C, rc.getAdxPeriod(), rc.getAtrPeriod(),
                    rc.getAdxTrendThreshold(), rc.getAtrVolatilePct(), rc.getAtrCompressionPct());
            MarketRegimeDetector.Regime last = regimes[sz - 1];
            return last != null ? last.name() : "RANGING";
        }

        private void keepRegimeBufferBounded() {
            while (regimeHighs.size() > 2000) {
                regimeHighs.remove(0);
                regimeLows.remove(0);
                regimeCloses.remove(0);
            }
        }

        // ── helpers ───────────────────────────────────────────────────────────

        private LocalDateTime bucketToLocalDateTime(long epochMs) {
            return Instant.ofEpochMilli(epochMs).atZone(IST).toLocalDateTime();
        }

        void stop() {
            stopped = true;
            if (tickFuture != null) tickFuture.cancel(true);
            if (decisionEngine != null) decisionEngine.cleanup();
        }

        // ── event builder ─────────────────────────────────────────────────────

        private OptionsReplayCandleEvent buildEvent(int emitted,
                CandleDto nifty, NiftyDecisionResult decision,
                OptionExecutionEngine exec, OptionSelectorService selector,
                LocalDateTime candleTime, String action) {

            CandleDto optCandle = exec.getActiveToken() != null
                    ? selector.getCandle(exec.getActiveToken(), candleTime) : null;

            return OptionsReplayCandleEvent.builder()
                    .emitted(emitted).total(0) // total=0 means "live/unknown"
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
                    .execWaitReason(exec.getExecWaitReason())
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
                    .confirmCount(decision.getConfirmCount())
                    .confirmRequired(decision.getConfirmRequired())
                    .candidates(toCandidateEvents(decision.getCandidates()))
                    // Execution
                    .positionState(exec.getState().name())
                    .desiredSide(exec.getDesiredSide().name())
                    .action(action)
                    .exitReason(exec.getLastExitReason())
                    .entryRegime(exec.getEntryRegime())
                    .appliedMinHold(exec.getAppliedMinHold())
                    .holdActive(exec.isHoldActive())
                    .peakPnlPct(exec.getPeakPnlPct())
                    .profitLockFloor(exec.getProfitLockFloor())
                    .inHoldZone(exec.isInHoldZone())
                    .inStrongTrendMode(exec.isInStrongTrendMode())
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
                    // Option candle for active instrument
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
                    .trendStrength(c.getTrendStrength())
                    .volatility(c.getVolatility())
                    .momentum(c.getMomentum())
                    .confidence(c.getConfidence())
                    .penalty(c.getPenalty())
                    .build()).collect(Collectors.toList());
        }
    }

    // ── Shared rule helpers (mirrors private methods in OptionsReplayService) ──

    static void applyTradingRules(NiftyDecisionResult decision,
                                  String regime,
                                  OptionsReplayRequest.TradingRules rules) {
        if (rules == null || !rules.isEnabled()) return;
        if (!decision.isEntryAllowed()) return;
        if (rules.isRangingNoTrade() && "RANGING".equals(regime)) {
            decision.setEntryAllowed(false);
            decision.setBlockReason("trading rule: no trade in RANGING");
        } else if (rules.isVolatileNoTrade() && "VOLATILE".equals(regime)) {
            decision.setEntryAllowed(false);
            decision.setBlockReason("trading rule: no trade in VOLATILE");
        }
    }

    static void applyScoreTierRules(NiftyDecisionResult decision,
                                    String regime,
                                    OptionsReplayRequest.TradeQualityConfig tqc,
                                    int barsSinceLastLoss) {
        if (tqc == null || !tqc.isEnabled()) return;
        if (!decision.isEntryAllowed()) return;
        if (!"WEAK".equals(decision.getTradeStrength())) return;

        if (tqc.getWeakTradeLossCooldown() > 0
                && barsSinceLastLoss < tqc.getWeakTradeLossCooldown()) {
            decision.setEntryAllowed(false);
            decision.setBlockReason("WEAK trade blocked: barsSinceLastLoss=" + barsSinceLastLoss
                    + " < cooldown=" + tqc.getWeakTradeLossCooldown());
            decision.setTradeStrength("NONE");
            return;
        }

        if (tqc.isBlockWeakInRanging() && "RANGING".equals(regime)) {
            boolean allowedByScore = tqc.getWeakRangingMinScore() > 0
                    && decision.getPenalizedScore() >= tqc.getWeakRangingMinScore()
                    && decision.getScoreGap() >= tqc.getWeakRangingMinGap();
            if (!allowedByScore) {
                decision.setEntryAllowed(false);
                decision.setBlockReason("WEAK trade blocked in RANGING (score="
                        + String.format("%.1f", decision.getPenalizedScore())
                        + " gap=" + String.format("%.1f", decision.getScoreGap())
                        + " need score>=" + tqc.getWeakRangingMinScore()
                        + " gap>=" + tqc.getWeakRangingMinGap() + ")");
                decision.setTradeStrength("NONE");
            }
        }
    }
}
