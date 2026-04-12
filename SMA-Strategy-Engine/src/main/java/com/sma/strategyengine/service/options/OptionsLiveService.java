package com.sma.strategyengine.service.options;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.entity.LiveSnapshotRecord;
import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.request.OptionsLiveRequest;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.model.response.OptionsReplayCandleEvent;
import com.sma.strategyengine.repository.LiveSnapshotRepository;
import com.sma.strategyengine.service.MarketRegimeDetector;
import com.sma.strategyengine.strategy.StrategyRegistry;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
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
import java.util.concurrent.atomic.AtomicBoolean;
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

    private final StrategyRegistry      strategyRegistry;
    private final DataEngineClient      dataEngineClient;
    private final ObjectMapper          objectMapper;
    private final LiveSnapshotRepository snapshotRepository;

    @Value("${strategy.data-engine.base-url:http://localhost:9005}")
    private String dataEngineBaseUrl;

    private static final ZoneId      IST          = ZoneId.of("Asia/Kolkata");
    private static final LocalTime   MARKET_OPEN  = LocalTime.of(9, 15);
    private static final LocalTime   MARKET_CLOSE = LocalTime.of(15, 30);

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

    private final ConcurrentHashMap<String, LiveOptionsSession> sessions       = new ConcurrentHashMap<>();

    // Feed cache for stopped sessions — expires after ~60 min
    private final ConcurrentHashMap<String, List<String>> completedFeeds     = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Instant>      completedFeedTimes = new ConcurrentHashMap<>();

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "opts-live-" + System.nanoTime());
        t.setDaemon(true);
        return t;
    });

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Starts a background trading session. Returns the sessionId immediately.
     * The session runs independently — no SSE emitter is required to keep it alive.
     * Persists the request config to DB so the session can be listed after restart.
     */
    public String start(OptionsLiveRequest req) {
        // One live session per (userId, brokerName) — stop any prior one first
        String key = req.getUserId() + "::" + req.getBrokerName().toLowerCase();
        sessions.values().stream()
                .filter(s -> key.equals(s.userId + "::" + s.req.getBrokerName().toLowerCase()))
                .map(s -> s.sessionId)
                .forEach(this::stopSession);

        String sessionId = UUID.randomUUID().toString();
        LiveOptionsSession session = new LiveOptionsSession(sessionId, req);
        sessions.put(sessionId, session);

        // Persist config so the UI can discover active sessions after reconnect
        persistSnapshot(sessionId, req);

        executor.execute(() -> {
            try {
                session.run();
            } catch (Exception e) {
                log.error("Options live session {} failed: {}", sessionId, e.getMessage(), e);
                stopSession(sessionId);
                session.broadcastError(e.getMessage());
            }
        });

        log.info("Options live session {} started (background): interval={}, CE={}, PE={}",
                sessionId, req.getInterval(),
                req.getCeOptions() != null ? req.getCeOptions().size() : 0,
                req.getPeOptions() != null ? req.getPeOptions().size() : 0);
        return sessionId;
    }

    /**
     * Attaches a new SSE emitter to an already-running session.
     * Replays the last {@code BUFFER_SIZE} candle events so the UI catches up immediately.
     * The session continues running if the client disconnects — only {@link #stop} kills it.
     */
    public SseEmitter attach(String sessionId) {
        LiveOptionsSession session = sessions.get(sessionId);
        if (session == null) return null;

        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);

        // Client disconnect removes emitter but does NOT stop the session
        emitter.onCompletion(() -> session.removeEmitter(emitter));
        emitter.onError(e  -> session.removeEmitter(emitter));

        // Replay recent events so the UI sees current state on reconnect
        session.replayBufferTo(emitter);

        session.addEmitter(emitter);
        log.info("Options live session {}: UI client attached ({} connected)",
                sessionId, session.emitterCount());
        return emitter;
    }

    /**
     * Explicitly stops a session. This is the ONLY way a session terminates other than
     * a fatal error inside the session thread.
     */
    public void stop(String sessionId) {
        stopSession(sessionId);
        deleteSnapshot(sessionId);
        log.info("Options live session {} stopped by request", sessionId);
    }

    /** Returns a snapshot of all active session IDs and their userId. */
    public List<Map<String, String>> listSessions() {
        return sessions.values().stream()
                .map(s -> Map.of(
                        "sessionId",  s.sessionId,
                        "userId",     s.userId,
                        "brokerName", s.req.getBrokerName(),
                        "interval",   s.req.getInterval(),
                        "startedAt",  s.startedAt.toString(),
                        "emitters",   String.valueOf(s.emitterCount())))
                .collect(Collectors.toList());
    }

    /** Returns the active sessionId for a given userId, or null if none running. */
    public String activeSessionForUser(String userId) {
        return sessions.values().stream()
                .filter(s -> userId.equals(s.userId))
                .map(s -> s.sessionId)
                .findFirst().orElse(null);
    }

    /**
     * Returns the full candle-event JSON list for a session (active or recently stopped).
     * Used by save-to-compare to fetch server-side feed instead of relying on client SSE state.
     */
    public List<String> getFeed(String sessionId) {
        LiveOptionsSession active = sessions.get(sessionId);
        if (active != null) return active.getFeedList();
        return completedFeeds.get(sessionId); // null if expired or never ran
    }

    /**
     * Sends an SSE comment (":ping") to all connected emitters every 15 seconds.
     * Keeps the Vercel proxy connection alive — without this, Vercel's reverse proxy
     * closes idle SSE streams after ~30 seconds of no data.
     */
    @Scheduled(fixedDelay = 15_000)
    public void heartbeat() {
        if (sessions.isEmpty()) return;
        for (LiveOptionsSession session : sessions.values()) {
            session.sendHeartbeat();
        }
    }

    private void stopSession(String sessionId) {
        LiveOptionsSession session = sessions.remove(sessionId);
        if (session != null) {
            completedFeeds.put(sessionId, session.getFeedList());
            completedFeedTimes.put(sessionId, Instant.now());
            session.stop();
        }
    }

    @Scheduled(fixedDelay = 1_800_000) // every 30 min — evict feeds older than 60 min
    public void cleanupCompletedFeeds() {
        Instant cutoff = Instant.now().minusSeconds(3600);
        completedFeedTimes.entrySet().removeIf(e -> e.getValue().isBefore(cutoff));
        completedFeeds.keySet().retainAll(completedFeedTimes.keySet());
    }

    private void persistSnapshot(String sessionId, OptionsLiveRequest req) {
        try {
            String json = objectMapper.writeValueAsString(req);
            LiveSnapshotRecord rec = snapshotRepository
                    .findByUserIdAndBrokerName(req.getUserId(), req.getBrokerName())
                    .orElse(new LiveSnapshotRecord());
            rec.setUserId(req.getUserId());
            rec.setBrokerName(req.getBrokerName());
            rec.setSessionId(sessionId);
            rec.setSavedAt(Instant.now());
            rec.setStateJson(json);
            snapshotRepository.save(rec);
        } catch (Exception e) {
            log.warn("Options live session {}: failed to persist snapshot: {}", sessionId, e.getMessage());
        }
    }

    private void deleteSnapshot(String sessionId) {
        try {
            sessions.values().stream()
                    .filter(s -> sessionId.equals(s.sessionId))
                    .findFirst()
                    .ifPresent(s -> snapshotRepository
                            .deleteByUserIdAndBrokerName(s.userId, s.req.getBrokerName()));
            // Also delete if session already removed from map
            snapshotRepository.findAll().stream()
                    .filter(r -> sessionId.equals(r.getSessionId()))
                    .forEach(r -> snapshotRepository.deleteByUserIdAndBrokerName(
                            r.getUserId(), r.getBrokerName()));
        } catch (Exception e) {
            log.warn("Options live session {}: failed to delete snapshot: {}", sessionId, e.getMessage());
        }
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

    /** How many recent candle events to buffer for late-joining / reconnecting UIs. */
    private static final int BUFFER_SIZE = 200;

    private class LiveOptionsSession {

        final String              sessionId;
        @Getter final String      userId;
        final OptionsLiveRequest  req;
        final long                ivMs;
        final Instant             startedAt = Instant.now();

        // Fan-out emitters — any number of UI clients can watch simultaneously.
        // The session keeps running when zero clients are connected.
        private final CopyOnWriteArrayList<SseEmitter> emitters = new CopyOnWriteArrayList<>();

        // Ring buffer of recent serialised candle-event strings for reconnecting UIs.
        private final Deque<String[]> eventBuffer = new ArrayDeque<>(BUFFER_SIZE);
        private final Object bufferLock = new Object();

        // Full candle event history for reliable save-to-compare (unbounded, not a ring buffer).
        private final List<String> feedList = new ArrayList<>();

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

        // Last computed regime — updated on each NIFTY candle close, used for tick evaluations
        volatile String currentRegime = "RANGING";

        // Market hours config — resolved from request in run()
        int     closeoutMins = 0;
        boolean marketClosed = false;

        volatile boolean   stopped    = false;
        volatile Future<?> tickFuture = null;

        // Live candle persistence buffer — null when recordCandles=false
        final LiveCandleBuffer candleBuffer;

        // Live tick persistence buffer — null when recordTicks=false
        final LiveTickBuffer tickBuffer;

        // ── emitter management ────────────────────────────────────────────────

        void addEmitter(SseEmitter e)    { emitters.add(e); }
        void removeEmitter(SseEmitter e) { emitters.remove(e); }
        int  emitterCount()              { return emitters.size(); }

        /** Sends an SSE comment to all emitters to prevent proxy timeout on idle connections. */
        void sendHeartbeat() {
            if (emitters.isEmpty()) return;
            List<SseEmitter> dead = null;
            for (SseEmitter e : emitters) {
                try { e.send(SseEmitter.event().comment("ping")); }
                catch (Exception ex) {
                    if (dead == null) dead = new ArrayList<>();
                    dead.add(e);
                }
            }
            if (dead != null) emitters.removeAll(dead);
        }

        /** Replays buffered events to a freshly attached emitter so it sees recent state. */
        void replayBufferTo(SseEmitter e) {
            List<String[]> snapshot;
            synchronized (bufferLock) { snapshot = new ArrayList<>(eventBuffer); }
            for (String[] ev : snapshot) {
                try { e.send(SseEmitter.event().name(ev[0]).data(ev[1])); }
                catch (Exception ignored) { break; }
            }
        }

        /** Broadcasts an error message to all connected UIs (session keeps running). */
        void broadcastError(String message) {
            broadcast("error", message);
        }

        /** Returns the full candle event history (for save-to-compare). */
        List<String> getFeedList() { return Collections.unmodifiableList(feedList); }

        /** Sends a named event to all connected emitters; silently removes dead ones. */
        private void broadcast(String eventName, String data) {
            // Buffer the event for late-joining UIs (candle, init, warning events)
            if ("candle".equals(eventName) || "init".equals(eventName) || "warning".equals(eventName)) {
                synchronized (bufferLock) {
                    if (eventBuffer.size() >= BUFFER_SIZE) eventBuffer.pollFirst();
                    eventBuffer.addLast(new String[]{ eventName, data });
                }
            }
            // Persist full candle history server-side for reliable save-to-compare
            if ("candle".equals(eventName)) {
                feedList.add(data);
            }
            if (emitters.isEmpty()) return;
            List<SseEmitter> dead = null;
            for (SseEmitter e : emitters) {
                try { e.send(SseEmitter.event().name(eventName).data(data)); }
                catch (Exception ex) {
                    if (dead == null) dead = new ArrayList<>();
                    dead.add(e);
                }
            }
            if (dead != null) emitters.removeAll(dead);
        }

        // ── constructor ───────────────────────────────────────────────────────

        LiveOptionsSession(String sessionId, OptionsLiveRequest req) {
            this.sessionId  = sessionId;
            this.userId     = req.getUserId();
            this.req        = req;
            this.ivMs       = INTERVAL_MS.getOrDefault(req.getInterval(), 300_000L);
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

            // Candle recording buffer — only allocated when the user opts in
            candleBuffer = req.isRecordCandles()
                    ? new LiveCandleBuffer(sessionId, req.getBrokerName().toLowerCase(), dataEngineClient)
                    : null;

            // Tick recording buffer — only allocated when the user opts in
            tickBuffer = req.isRecordTicks()
                    ? new LiveTickBuffer(sessionId, req.getBrokerName().toLowerCase(), dataEngineClient)
                    : null;
        }

        /** Kite interval string for the configured interval — used by the candle buffer. */
        private String kiteIntervalValue() {
            return switch (req.getInterval()) {
                case "MINUTE_1"  -> "minute";
                case "MINUTE_3"  -> "3minute";
                case "MINUTE_5"  -> "5minute";
                case "MINUTE_10" -> "10minute";
                case "MINUTE_15" -> "15minute";
                case "MINUTE_30" -> "30minute";
                case "MINUTE_60" -> "60minute";
                case "DAY"       -> "day";
                default          -> "5minute";
            };
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

            // Resolve trading hours config
            OptionsReplayRequest.TradingHoursConfig thc =
                    Optional.ofNullable(req.getTradingHoursConfig())
                            .orElse(new OptionsReplayRequest.TradingHoursConfig());
            closeoutMins = thc.isEnabled() ? thc.getNoNewEntriesMinutesBeforeClose() : 0;

            // Phase 1b: pre-warm option candle maps with today's historical data
            // so the selector has price data immediately (before any option ticks arrive)
            warmupOptionCandles();

            // Broadcast init event (buffered so reconnecting UIs see it immediately)
            try {
                broadcast("init", objectMapper.writeValueAsString(Map.of(
                        "sessionId",     sessionId,
                        "warmupCandles", warmupCandles.size(),
                        "ceOptions",     cePool.size(),
                        "peOptions",     pePool.size())));
            } catch (Exception e) {
                log.warn("Options live session {}: init event serialisation failed: {}", sessionId, e.getMessage());
            }

            // Phase 2: subscribe NIFTY + option tokens to Data Engine live stream
            if (!stopped) {
                subscribeTokens();
            }

            // Phase 3: consume tick SSE
            if (!stopped) {
                tickFuture = executor.submit(this::readTickStream);
            }
        }

        // ── token subscription ────────────────────────────────────────────────

        private void subscribeTokens() {
            List<Map<String, Object>> instruments = new ArrayList<>();

            // NIFTY index
            if (niftyToken > 0) {
                instruments.add(Map.of(
                        "instrumentToken", niftyToken,
                        "symbol",          req.getNiftySymbol()   != null ? req.getNiftySymbol()   : "NIFTY 50",
                        "exchange",        req.getNiftyExchange() != null ? req.getNiftyExchange() : "NSE"));
            }

            // CE + PE options
            for (OptionsReplayRequest.OptionCandidate c : cePool) {
                if (c.getInstrumentToken() != null) {
                    instruments.add(Map.of(
                            "instrumentToken", c.getInstrumentToken(),
                            "symbol",          c.getTradingSymbol() != null ? c.getTradingSymbol() : "",
                            "exchange",        c.getExchange()      != null ? c.getExchange()      : "NFO"));
                }
            }
            for (OptionsReplayRequest.OptionCandidate c : pePool) {
                if (c.getInstrumentToken() != null) {
                    instruments.add(Map.of(
                            "instrumentToken", c.getInstrumentToken(),
                            "symbol",          c.getTradingSymbol() != null ? c.getTradingSymbol() : "",
                            "exchange",        c.getExchange()      != null ? c.getExchange()      : "NFO"));
                }
            }

            if (instruments.isEmpty()) {
                log.warn("Options live session {}: no tokens to subscribe", sessionId);
                return;
            }

            try {
                dataEngineClient.subscribe(
                        req.getUserId(), req.getBrokerName(),
                        req.getApiKey(), req.getAccessToken(),
                        instruments);
                log.info("Options live session {}: subscribed {} token(s)", sessionId, instruments.size());
            } catch (Exception e) {
                log.warn("Options live session {}: subscription failed (ticks may not arrive): {}",
                        sessionId, e.getMessage());
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
            OptionsReplayRequest.PenaltyConfig pc =
                    Optional.ofNullable(req.getPenaltyConfig()).orElse(new OptionsReplayRequest.PenaltyConfig());

            decisionEngine  = new NiftyDecisionEngine(
                    strategyRegistry, req.getStrategies(), dc, sc, rr, rsr, cr, rqc, tqc, tec, cec, pc);

            // Pass live map by reference — new candles added to liveOptionCandles are visible immediately
            selectorService = OptionSelectorService.forLive(sel, liveOptionCandles);

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

        // ── option candle pre-warm ────────────────────────────────────────────

        /**
         * Fetches today's historical candles for every CE/PE option token and
         * seeds {@link #liveOptionCandles} so the selector has price data before
         * any live option ticks arrive. Failures per token are logged and skipped.
         */
        private void warmupOptionCandles() {
            LocalDateTime todayOpen = LocalDateTime.now(IST)
                    .withHour(9).withMinute(15).withSecond(0).withNano(0);
            LocalDateTime now = LocalDateTime.now(IST);

            List<OptionsReplayRequest.OptionCandidate> all = new ArrayList<>();
            all.addAll(cePool);
            all.addAll(pePool);

            int loaded = 0;
            for (OptionsReplayRequest.OptionCandidate c : all) {
                if (c.getInstrumentToken() == null) continue;
                try {
                    List<CandleDto> candles = dataEngineClient.fetchHistory(
                            new DataEngineClient.HistoryRequest(
                                    req.getUserId(), req.getBrokerName(),
                                    req.getApiKey(), req.getAccessToken(),
                                    c.getInstrumentToken(),
                                    c.getTradingSymbol() != null ? c.getTradingSymbol() : "",
                                    c.getExchange()      != null ? c.getExchange()      : "NFO",
                                    req.getInterval(), todayOpen, now, false));

                    NavigableMap<LocalDateTime, CandleDto> map = liveOptionCandles.get(c.getInstrumentToken());
                    if (map != null) {
                        for (CandleDto candle : candles) {
                            map.put(candle.openTime(), candle);
                        }
                        loaded += candles.size();
                        log.info("Options live session {}: pre-warmed {} candles for {}",
                                sessionId, candles.size(), c.getTradingSymbol());
                    }
                } catch (Exception e) {
                    log.warn("Options live session {}: option warmup failed for {} ({}): {}",
                            sessionId, c.getTradingSymbol(), c.getInstrumentToken(), e.getMessage());
                }
            }
            log.info("Options live session {}: option pre-warm complete, {} total candles across {} instruments",
                    sessionId, loaded, all.size());
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

            emitTickEvent(token, ltp, epochMs);

            // Record raw tick if opted in
            if (tickBuffer != null) {
                boolean isNifty = (token == niftyToken);
                String sym  = isNifty ? req.getNiftySymbol()   : resolveOptionSymbol(token);
                String exch = isNifty ? req.getNiftyExchange()  : resolveOptionExchange(token);
                tickBuffer.add(token, sym, exch, ltp, volumeToday, epochMs);
            }
        }

        private void emitTickEvent(long token, double ltp, long epochMs) {
            if (emitters.isEmpty()) return; // no UI connected — skip tick serialisation
            try {
                boolean isNifty = (token == niftyToken);
                FormingCandle fc = forming.get(token);

                Map<String, Object> evt = new java.util.LinkedHashMap<>();
                evt.put("token",   token);
                evt.put("isNifty", isNifty);
                evt.put("ltp",     ltp);
                evt.put("timeMs",  epochMs);
                if (fc != null) {
                    evt.put("fOpen",  fc.open);
                    evt.put("fHigh",  fc.high);
                    evt.put("fLow",   fc.low);
                    evt.put("fClose", fc.close);
                }
                // Tick events are NOT buffered — high-frequency, no replay needed
                String json = objectMapper.writeValueAsString(evt);
                List<SseEmitter> dead = null;
                for (SseEmitter e : emitters) {
                    try { e.send(SseEmitter.event().name("tick").data(json)); }
                    catch (Exception ex) {
                        if (dead == null) dead = new ArrayList<>();
                        dead.add(e);
                    }
                }
                if (dead != null) emitters.removeAll(dead);
            } catch (Exception ignored) {}
        }

        private String marketPhase(LocalDateTime bucketLDT) {
            LocalTime t = bucketLDT.toLocalTime();
            if (t.isBefore(MARKET_OPEN))   return "PRE_MARKET";
            if (!t.isBefore(MARKET_CLOSE)) return "CLOSED";
            if (closeoutMins > 0 && !t.isBefore(MARKET_CLOSE.minusMinutes(closeoutMins))) return "CLOSING";
            return "TRADING";
        }

        private void processNiftyTick(double ltp, long volumeToday, long bucketMs) {
            LocalDateTime bucketLDT = bucketToLocalDateTime(bucketMs);
            String  phase   = marketPhase(bucketLDT);
            boolean tradable = "TRADING".equals(phase);

            // Force-close once when market crosses 15:30
            if ("CLOSED".equals(phase) && !marketClosed) {
                marketClosed = true;
                if (execEngine != null && execEngine.getState() != OptionExecutionEngine.PositionState.FLAT) {
                    execEngine.forceClose(selectorService, bucketLDT);
                }
            }

            FormingCandle cur = forming.get(niftyToken);
            if (cur == null) {
                forming.put(niftyToken, new FormingCandle(ltp, volumeToday, bucketMs));
            } else if (bucketMs > cur.startMs) {
                // Candle closed — push to scorer so next tick evaluation uses updated history
                CandleDto closed = cur.toCandle(bucketToLocalDateTime(cur.startMs));
                forming.put(niftyToken, new FormingCandle(ltp, volumeToday, bucketMs));
                snapshotOptionCandles(cur.startMs, closed.openTime());
                // Record NIFTY candle if opted in
                if (candleBuffer != null) {
                    candleBuffer.add(niftyToken,
                            req.getNiftySymbol(), req.getNiftyExchange(),
                            kiteIntervalValue(), closed);
                }
                onNiftyCandleClose(closed);
                // Evaluate the first tick of the new bucket immediately (scorer now includes closed candle)
                snapshotOptionCandles(bucketMs, bucketToLocalDateTime(bucketMs));
                emitTickCandleEvent(forming.get(niftyToken), bucketMs, phase, tradable);
            } else {
                cur.update(ltp, volumeToday);
                // Snapshot current option forming prices so selector sees live prices intra-candle
                snapshotOptionCandles(bucketMs, bucketToLocalDateTime(bucketMs));
                emitTickCandleEvent(cur, bucketMs, phase, tradable);
            }
        }

        /** Full live execution pipeline on every NIFTY tick. */
        private void emitTickCandleEvent(FormingCandle fc, long bucketMs,
                                         String marketPhase, boolean tradable) {
            if (decisionEngine == null || selectorService == null || execEngine == null) return;
            try {
                LocalDateTime openTime = bucketToLocalDateTime(bucketMs);
                CandleDto snapshot = fc.toCandle(openTime);

                // Full stateful decision (confirmation state machine runs on every tick — all phases)
                NiftyDecisionResult decision = decisionEngine.evaluateTick(snapshot, currentRegime);

                // Post-process with trading and quality rules
                applyTradingRules(decision, currentRegime, req.getTradingRules());
                applyScoreTierRules(decision, currentRegime,
                        req.getTradeQualityConfig(), execEngine.getBarsSinceLastLoss());

                // Gate execution by market phase
                double niftyClose = snapshot.close().doubleValue();
                String action;
                if ("CLOSED".equals(marketPhase)) {
                    // Force-close already handled in processNiftyTick; skip further process()
                    action = execEngine.getState() != OptionExecutionEngine.PositionState.FLAT
                            ? execEngine.process(decision, selectorService, cePool, pePool, niftyClose, openTime, snapshot)
                            : "—";
                } else if (!tradable && execEngine.getState() == OptionExecutionEngine.PositionState.FLAT) {
                    // PRE_MARKET or CLOSING with no open position — no new entries
                    action = "HOLD";
                } else {
                    // TRADING, or in-position during CLOSING (manage/exit)
                    action = execEngine.process(decision, selectorService,
                            cePool, pePool, niftyClose, openTime, snapshot);
                }

                emittedCount++;
                OptionsReplayCandleEvent event = buildEvent(
                        emittedCount, snapshot, decision, execEngine, selectorService,
                        openTime, action, marketPhase, tradable);

                broadcast("candle", objectMapper.writeValueAsString(event));

                // ── divergence debug (enable via logging.level.com.sma=DEBUG) ──
                if (log.isDebugEnabled()) {
                    logCandleDebug(bucketMs, event);
                }
            } catch (Exception e) {
                log.debug("Options live session {}: tick candle emit failed: {}", sessionId, e.getMessage());
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
                // Record option candle if opted in
                if (candleBuffer != null) {
                    String sym = resolveOptionSymbol(token);
                    String exch = resolveOptionExchange(token);
                    candleBuffer.add(token, sym, exch, kiteIntervalValue(), closed);
                }
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

        /**
         * Called when a NIFTY candle closes. Updates the scorer rolling window and
         * regime so the next tick evaluation runs with fresh closed-candle history.
         * Execution is driven by {@link #emitTickCandleEvent} on every tick.
         */
        private void onNiftyCandleClose(CandleDto niftyCandle) {
            if (stopped || decisionEngine == null) return;

            // Update regime rolling buffers
            regimeHighs.add(niftyCandle.high().doubleValue());
            regimeLows.add(niftyCandle.low().doubleValue());
            regimeCloses.add(niftyCandle.close().doubleValue());
            keepRegimeBufferBounded();

            // Recompute regime with the closed candle included
            currentRegime = computeRegime();

            // Push closed candle into scorer/VWAP history — no decision or execution here
            decisionEngine.pushCandle(niftyCandle);
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
            // Flush any remaining buffered candles/ticks before shutting down
            if (candleBuffer != null) candleBuffer.stop();
            if (tickBuffer  != null) tickBuffer.stop();
            // Complete all connected UI emitters so browsers know the session ended
            for (SseEmitter e : emitters) {
                try { e.complete(); } catch (Exception ignored) {}
            }
            emitters.clear();
        }

        /** Returns the trading symbol for an option token, or empty string if not found. */
        private String resolveOptionSymbol(long token) {
            for (OptionsReplayRequest.OptionCandidate c : cePool) {
                if (c.getInstrumentToken() != null && c.getInstrumentToken() == token)
                    return c.getTradingSymbol() != null ? c.getTradingSymbol() : "";
            }
            for (OptionsReplayRequest.OptionCandidate c : pePool) {
                if (c.getInstrumentToken() != null && c.getInstrumentToken() == token)
                    return c.getTradingSymbol() != null ? c.getTradingSymbol() : "";
            }
            return "";
        }

        /** Returns the exchange for an option token, defaulting to "NFO". */
        private String resolveOptionExchange(long token) {
            for (OptionsReplayRequest.OptionCandidate c : cePool) {
                if (c.getInstrumentToken() != null && c.getInstrumentToken() == token)
                    return c.getExchange() != null ? c.getExchange() : "NFO";
            }
            for (OptionsReplayRequest.OptionCandidate c : pePool) {
                if (c.getInstrumentToken() != null && c.getInstrumentToken() == token)
                    return c.getExchange() != null ? c.getExchange() : "NFO";
            }
            return "NFO";
        }

        // ── event builder ─────────────────────────────────────────────────────

        private OptionsReplayCandleEvent buildEvent(int emitted,
                CandleDto nifty, NiftyDecisionResult decision,
                OptionExecutionEngine exec, OptionSelectorService selector,
                LocalDateTime candleTime, String action,
                String marketPhase, boolean tradable) {

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
                    .marketPhase(marketPhase)
                    .tradable(tradable)
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

        // ── divergence debug helper ───────────────────────────────────────────

        /** Logs one line per NIFTY event plus one line per option token snapshot.
         *  Mirror of the same helper in {@link TickOptionsReplayService}.
         *  tickEpochMs is unavailable in emitTickCandleEvent — always 0 for LIVE mode. */
        private void logCandleDebug(long bucketMs, OptionsReplayCandleEvent e) {
            log.debug("[LIVE][{}] tick=0 bucket={} niftyTime={} regime={} bias={} winner={} score={} "
                    + "entryAllowed={} blockReason={} execWait={} state={} action={} "
                    + "token={} symbol={} entryPx={} capital={}",
                    sessionId, bucketMs,
                    e.getNiftyTime(), e.getRegime(), e.getConfirmedBias(),
                    e.getWinnerStrategy(), String.format("%.2f", e.getWinnerScore()),
                    e.isEntryAllowed(),
                    e.getBlockReason()    != null ? e.getBlockReason()    : "-",
                    e.getExecWaitReason() != null ? e.getExecWaitReason() : "-",
                    e.getPositionState(), e.getAction(),
                    e.getSelectedToken()        != null ? e.getSelectedToken()        : "-",
                    e.getSelectedTradingSymbol() != null ? e.getSelectedTradingSymbol() : "-",
                    String.format("%.2f", e.getEntryPrice()),
                    String.format("%.2f", e.getCapital()));
            LocalDateTime bucketLdt = bucketToLocalDateTime(bucketMs);
            for (Long token : optionTokens) {
                NavigableMap<LocalDateTime, CandleDto> map = liveOptionCandles.get(token);
                FormingCandle fc = forming.get(token);
                boolean hasSameBucket = fc != null && fc.startMs == bucketMs;
                CandleDto snap = map != null ? map.get(bucketLdt) : null;
                log.debug("[LIVE][{}]   opt-snap token={} bucketMs={} hasSameBucketForming={} "
                        + "snapPresent={} O={} H={} L={} C={}",
                        sessionId, token, bucketMs, hasSameBucket,
                        snap != null,
                        snap != null ? snap.open()  : "-",
                        snap != null ? snap.high()  : "-",
                        snap != null ? snap.low()   : "-",
                        snap != null ? snap.close() : "-");
            }
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
