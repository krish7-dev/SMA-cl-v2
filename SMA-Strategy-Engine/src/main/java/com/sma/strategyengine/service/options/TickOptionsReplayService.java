package com.sma.strategyengine.service.options;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.model.request.TickOptionsReplayRequest;
import com.sma.strategyengine.model.response.OptionsReplayCandleEvent;
import com.sma.strategyengine.service.MarketRegimeDetector;
import com.sma.strategyengine.service.SessionPersistenceService;
import com.sma.strategyengine.strategy.StrategyRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;

/**
 * Session-based tick replay service — mirrors OptionsLiveService but sources
 * ticks from the database instead of Kite WebSocket.
 *
 * <p>Lifecycle (same as OptionsLiveService):
 * <ol>
 *   <li>{@link #start} — loads DB ticks in background, returns sessionId immediately.</li>
 *   <li>{@link #attach} — attach a UI SSE emitter; replays recent event buffer on join.</li>
 *   <li>{@link #stop} — explicitly stops the session (UI disconnect does NOT stop it).</li>
 * </ol>
 *
 * <p>The session auto-removes itself from the map when the tick stream is exhausted.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TickOptionsReplayService {

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private static final Map<String, Long> INTERVAL_MS = Map.of(
            "MINUTE_1",   60_000L,
            "MINUTE_3",  180_000L,
            "MINUTE_5",  300_000L,
            "MINUTE_10", 600_000L,
            "MINUTE_15", 900_000L,
            "MINUTE_30", 1_800_000L,
            "MINUTE_60", 3_600_000L
    );

    private static final int BUFFER_SIZE = 200;

    private static final int CHUNK_SIZE = 200;

    private final StrategyRegistry          strategyRegistry;
    private final DataEngineClient          dataEngineClient;
    private final ObjectMapper              objectMapper;
    private final SessionPersistenceService sessionPersistenceService;

    private final ConcurrentHashMap<String, TickReplaySession> sessions = new ConcurrentHashMap<>();

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "tick-replay-" + System.nanoTime());
        t.setDaemon(true);
        return t;
    });

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Starts a background tick replay session.
     * Returns immediately with a sessionId — the session runs independently.
     */
    public String start(TickOptionsReplayRequest req) {
        String sessionId = UUID.randomUUID().toString();
        TickReplaySession session = new TickReplaySession(sessionId, req);
        sessions.put(sessionId, session);

        executor.execute(() -> {
            try {
                session.run();
            } catch (Exception e) {
                log.error("Tick replay session {} failed: {}", sessionId, e.getMessage(), e);
                session.broadcastError(e.getMessage());
            } finally {
                sessions.remove(sessionId);
                session.autoSave();
                session.completeEmitters();
            }
        });

        log.info("Tick replay session {} started: tickSession={} interval={} CE={} PE={}",
                sessionId, req.getSessionId(), req.getInterval(),
                req.getCeOptions() != null ? req.getCeOptions().size() : 0,
                req.getPeOptions() != null ? req.getPeOptions().size() : 0);
        return sessionId;
    }

    /**
     * Attaches a UI SSE emitter to a running session.
     * Replays the last {@value BUFFER_SIZE} buffered events so the UI catches up.
     * Closing the stream does NOT stop the session — only {@link #stop} does.
     */
    public SseEmitter attach(String sessionId) {
        TickReplaySession session = sessions.get(sessionId);
        if (session == null) return null;

        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);
        emitter.onCompletion(() -> session.removeEmitter(emitter));
        emitter.onError(e   -> session.removeEmitter(emitter));

        session.replayBufferTo(emitter);
        session.addEmitter(emitter);
        log.info("Tick replay session {}: UI attached ({} connected)", sessionId, session.emitterCount());
        return emitter;
    }

    /**
     * Explicitly stops a session. Sessions also auto-stop when the tick stream is exhausted.
     */
    public void stop(String sessionId) {
        TickReplaySession session = sessions.remove(sessionId);
        if (session != null) {
            session.autoSave();
            session.stop();
            log.info("Tick replay session {} stopped by request", sessionId);
        }
    }

    /** Feed is now persisted to session_feed_chunk during replay — assembled by SessionResultController. */
    public List<String> getFeed(String sessionId) {
        return null; // assembled from DB chunks via GET /session-results/{sessionId}
    }

    /** Returns a snapshot of all active (still-running) replay sessions. */
    public List<Map<String, String>> listSessions() {
        return sessions.values().stream()
                .map(s -> Map.of(
                        "sessionId",     s.sessionId,
                        "tickSessionId", s.req.getSessionId() != null ? s.req.getSessionId() : "",
                        "interval",      s.req.getInterval()  != null ? s.req.getInterval()  : "MINUTE_5",
                        "startedAt",     s.startedAt.toString(),
                        "emitters",      String.valueOf(s.emitterCount())))
                .collect(Collectors.toList());
    }

    @Scheduled(fixedDelay = 15_000)
    public void heartbeat() {
        for (TickReplaySession s : sessions.values()) s.sendHeartbeat();
    }

    // ── Inner session class ───────────────────────────────────────────────────

    private class TickReplaySession {

        private static final LocalTime MARKET_OPEN  = LocalTime.of(9, 15);
        private static final LocalTime MARKET_CLOSE = LocalTime.of(15, 30);

        final String                   sessionId;
        final TickOptionsReplayRequest req;
        final long                     ivMs;
        final Instant                  startedAt = Instant.now();

        private final CopyOnWriteArrayList<SseEmitter> emitters    = new CopyOnWriteArrayList<>();
        private final Deque<String[]>                  eventBuffer = new ArrayDeque<>(BUFFER_SIZE);
        private final Object                           bufferLock  = new Object();

        // Chunk buffer — flushed to session_feed_chunk every CHUNK_SIZE events.
        private final List<String> chunkBuffer = new ArrayList<>(CHUNK_SIZE);
        private int emittedChunks = 0;

        volatile boolean stopped = false;

        // ── emitter management ────────────────────────────────────────────────

        void addEmitter(SseEmitter e)    { emitters.add(e); }
        void removeEmitter(SseEmitter e) { emitters.remove(e); }
        int  emitterCount()              { return emitters.size(); }

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

        void replayBufferTo(SseEmitter e) {
            List<String[]> snapshot;
            synchronized (bufferLock) { snapshot = new ArrayList<>(eventBuffer); }
            for (String[] ev : snapshot) {
                try { e.send(SseEmitter.event().name(ev[0]).data(ev[1])); }
                catch (Exception ignored) { break; }
            }
        }

        void broadcastError(String message) { broadcast("error", "\"" + message + "\""); }

        void persistChunk() {
            if (chunkBuffer.isEmpty()) return;
            try {
                String json = "[" + String.join(",", chunkBuffer) + "]";
                String sessionDate = req.getFromDate() != null
                        ? req.getFromDate().toString().substring(0, 10)
                        : LocalDate.now().toString();
                sessionPersistenceService.appendFeedChunkTyped(
                        sessionId, "TICK_REPLAY",
                        req.getUserId(),
                        req.getBrokerName() != null ? req.getBrokerName() : "kite",
                        sessionDate, json);
                emittedChunks++;
            } catch (Exception e) {
                log.warn("TICK_REPLAY chunk persist failed: sessionId={} size={} error={}",
                        sessionId, chunkBuffer.size(), e.getMessage());
            }
            chunkBuffer.clear();
        }

        void autoSave() {
            // Flush any remaining buffered events to DB
            persistChunk();

            if (emittedChunks == 0) {
                log.info("TICK_REPLAY auto-save skipped (no candles emitted): sessionId={}", sessionId);
                return;
            }
            // Write metadata only — feed is already in session_feed_chunk rows
            try {
                Map<String, Object> summaryMap = new LinkedHashMap<>();
                summaryMap.put("dataEngineSessionId", req.getSessionId());
                summaryMap.put("fromDate",            req.getFromDate());
                summaryMap.put("toDate",              req.getToDate());
                summaryMap.put("sessionEnd",          Instant.now().toString());
                sessionPersistenceService.updateMetadata(
                        sessionId, null,
                        objectMapper.writeValueAsString(summaryMap),
                        objectMapper.writeValueAsString(req), "");
                log.info("TICK_REPLAY auto-saved: sessionId={} chunks={}", sessionId, emittedChunks);
            } catch (Exception e) {
                log.error("TICK_REPLAY auto-save metadata failed: sessionId={} error={}", sessionId, e.getMessage());
            }
        }

        private void broadcast(String eventName, String data) {
            if ("candle".equals(eventName) || "init".equals(eventName) || "summary".equals(eventName) || "warning".equals(eventName)) {
                synchronized (bufferLock) {
                    if (eventBuffer.size() >= BUFFER_SIZE) eventBuffer.pollFirst();
                    eventBuffer.addLast(new String[]{ eventName, data });
                }
            }
            // Persist candle events to DB in batches for reliable save-to-compare
            if ("candle".equals(eventName)) {
                chunkBuffer.add(data);
                if (chunkBuffer.size() >= CHUNK_SIZE) {
                    persistChunk();
                }
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

        void completeEmitters() {
            for (SseEmitter e : emitters) {
                try { e.complete(); } catch (Exception ignored) {}
            }
            emitters.clear();
        }

        void stop() {
            stopped = true;
            completeEmitters();
        }

        // ── constructor ───────────────────────────────────────────────────────

        TickReplaySession(String sessionId, TickOptionsReplayRequest req) {
            this.sessionId = sessionId;
            this.req       = req;
            this.ivMs      = INTERVAL_MS.getOrDefault(req.getInterval(), 300_000L);
        }

        // ── run ───────────────────────────────────────────────────────────────

        void run() throws Exception {
            long niftyToken = req.getNiftyInstrumentToken() != null
                    ? req.getNiftyInstrumentToken() : -1L;

            List<OptionsReplayRequest.OptionCandidate> cePool =
                    req.getCeOptions() != null ? req.getCeOptions() : List.of();
            List<OptionsReplayRequest.OptionCandidate> pePool =
                    req.getPeOptions() != null ? req.getPeOptions() : List.of();

            Set<Long> optionTokens = new HashSet<>();
            for (OptionsReplayRequest.OptionCandidate c : cePool)
                if (c.getInstrumentToken() != null) optionTokens.add(c.getInstrumentToken());
            for (OptionsReplayRequest.OptionCandidate c : pePool)
                if (c.getInstrumentToken() != null) optionTokens.add(c.getInstrumentToken());

            // ── 1. Fetch all ticks from DB ─────────────────────────────────────
            List<Long> allTokens = new ArrayList<>();
            if (niftyToken > 0) allTokens.add(niftyToken);
            allTokens.addAll(optionTokens);

            List<DataEngineClient.TickEntry> ticks = dataEngineClient.fetchSessionTicks(
                    new DataEngineClient.TickQueryPayload(
                            req.getSessionId(), allTokens, req.getFromDate(), req.getToDate()));

            if (ticks.isEmpty()) {
                broadcast("error", "\"No ticks found for sessionId=" + req.getSessionId() + "\"");
                return;
            }

            log.info("Tick replay session {}: {} ticks loaded for DB session {}",
                    sessionId, ticks.size(), req.getSessionId());

            // Derive session date from first tick (for warmup date ranges)
            LocalDateTime firstTickLDT = toLDT(ticks.get(0).tickTimeMs());
            LocalDateTime sessionDate  = firstTickLDT.toLocalDate().atStartOfDay();

            // ── 2. NIFTY warmup (DB first → broker API fallback) ───────────────
            List<DataEngineClient.CandleDto> warmupCandles = List.of();
            List<Double> regimeHighs  = new ArrayList<>();
            List<Double> regimeLows   = new ArrayList<>();
            List<Double> regimeCloses = new ArrayList<>();

            if (req.getWarmupDays() > 0 && niftyToken > 0) {
                try {
                    LocalDateTime warmupFrom = sessionDate
                            .minusDays((long) req.getWarmupDays() + 7)
                            .withHour(9).withMinute(15).withSecond(0).withNano(0);
                    LocalDateTime warmupTo   = firstTickLDT;

                    warmupCandles = dataEngineClient.fetchHistory(
                            new DataEngineClient.HistoryRequest(
                                    req.getUserId(), req.getBrokerName(),
                                    req.getNiftyInstrumentToken(),
                                    req.getNiftySymbol(), req.getNiftyExchange(),
                                    req.getInterval(), warmupFrom, warmupTo, false));

                    for (DataEngineClient.CandleDto c : warmupCandles) {
                        regimeHighs.add(c.high().doubleValue());
                        regimeLows.add(c.low().doubleValue());
                        regimeCloses.add(c.close().doubleValue());
                    }
                    keepRegimeBounded(regimeHighs, regimeLows, regimeCloses);

                    log.info("Tick replay session {}: loaded {} NIFTY warmup candles", sessionId, warmupCandles.size());
                } catch (Exception e) {
                    String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                    log.warn("Tick replay session {}: NIFTY warmup failed (continuing cold): {}", sessionId, msg);
                    broadcast("warning", "\"NIFTY warmup failed — indicators starting cold. " +
                            (msg.toLowerCase().contains("token") || msg.toLowerCase().contains("auth") || msg.toLowerCase().contains("401")
                                    ? "Access token may be expired." : msg) + "\"");
                    warmupCandles = List.of();
                }
            }

            // ── 3. Initialise engines ──────────────────────────────────────────
            NiftyDecisionEngine decisionEngine = buildDecisionEngine();
            if (!warmupCandles.isEmpty()) {
                decisionEngine.warmup(warmupCandles);
            }

            Map<Long, NavigableMap<LocalDateTime, CandleDto>> liveOptionCandles = new HashMap<>();
            for (Long token : optionTokens) liveOptionCandles.put(token, new TreeMap<>());

            OptionSelectorService selectorService = OptionSelectorService.forLive(
                    Optional.ofNullable(req.getSelectionConfig())
                            .orElse(new OptionsReplayRequest.SelectionConfig()),
                    liveOptionCandles);

            OptionExecutionEngine execEngine = new OptionExecutionEngine(buildExecRequest());

            // ── 4. Option candle pre-warm (session day, DB first → broker fallback) ──
            if (!optionTokens.isEmpty()) {
                LocalDateTime optWarmFrom = sessionDate
                        .withHour(9).withMinute(15).withSecond(0).withNano(0);
                LocalDateTime optWarmTo   = firstTickLDT;
                int optLoaded = 0;
                for (OptionsReplayRequest.OptionCandidate c : cePool) {
                    optLoaded += warmupOptionCandles(c, optWarmFrom, optWarmTo, liveOptionCandles);
                }
                for (OptionsReplayRequest.OptionCandidate c : pePool) {
                    optLoaded += warmupOptionCandles(c, optWarmFrom, optWarmTo, liveOptionCandles);
                }
                log.info("Tick replay session {}: option pre-warm complete, {} candles loaded", sessionId, optLoaded);
            }

            Map<Long, OptionsLiveService.FormingCandle> forming = new HashMap<>();
            // Start as RANGING — exactly like live service.
            // Warmup data is in regimeHighs/regimeLows/regimeCloses; regime is recomputed
            // on the first candle close (same timing as live).
            String currentRegime = "RANGING";
            int emittedCount = 0;

            // ── Trading hours config ───────────────────────────────────────────
            OptionsReplayRequest.TradingHoursConfig thc =
                    Optional.ofNullable(req.getTradingHoursConfig())
                            .orElse(new OptionsReplayRequest.TradingHoursConfig());
            boolean tradingHoursEnabled = thc.isEnabled();
            int closeoutMins = tradingHoursEnabled ? thc.getNoNewEntriesMinutesBeforeClose() : 0;
            boolean marketClosed = false;

            // ── 5. Broadcast init ──────────────────────────────────────────────
            broadcast("init", objectMapper.writeValueAsString(Map.of(
                    "totalTicks",    ticks.size(),
                    "tickSessionId", req.getSessionId() != null ? req.getSessionId() : "",
                    "interval",      req.getInterval()  != null ? req.getInterval()  : "MINUTE_5",
                    "warmupCandles", warmupCandles.size())));

            // ── 4. Replay tick stream ──────────────────────────────────────────
            final boolean realTimedReplay =
                    req.getSpeedMultiplier() > 0 && req.getSpeedMultiplier() < 10_000;
            final long firstTickMs = realTimedReplay ? ticks.get(0).tickTimeMs() : 0L;
            final long startWallMs = realTimedReplay ? System.currentTimeMillis() : 0L;

            for (DataEngineClient.TickEntry tick : ticks) {
                if (stopped) break;

                long   token   = tick.instrumentToken();
                double ltp     = tick.ltp();
                long   vol     = tick.volume();
                long   epochMs = tick.tickTimeMs();
                long   bucketMs = (epochMs / ivMs) * ivMs;

                if (token == niftyToken) {
                    OptionsLiveService.FormingCandle cur = forming.get(token);
                    if (cur == null) {
                        forming.put(token, new OptionsLiveService.FormingCandle(ltp, vol, bucketMs));
                    } else if (bucketMs > cur.startMs) {
                        // NIFTY candle closed
                        CandleDto closed = cur.toCandle(toLDT(cur.startMs));
                        forming.put(token, new OptionsLiveService.FormingCandle(ltp, vol, bucketMs));
                        snapshotOptionCandles(cur.startMs, closed.openTime(),
                                forming, liveOptionCandles, optionTokens, ivMs);
                        regimeHighs.add(closed.high().doubleValue());
                        regimeLows.add(closed.low().doubleValue());
                        regimeCloses.add(closed.close().doubleValue());
                        keepRegimeBounded(regimeHighs, regimeLows, regimeCloses);
                        currentRegime = computeRegime(req.getRegimeConfig(),
                                regimeHighs, regimeLows, regimeCloses);
                        decisionEngine.pushCandle(closed);
                        snapshotOptionCandles(bucketMs, toLDT(bucketMs),
                                forming, liveOptionCandles, optionTokens, ivMs);
                    } else {
                        cur.update(ltp, vol);
                        snapshotOptionCandles(bucketMs, toLDT(bucketMs),
                                forming, liveOptionCandles, optionTokens, ivMs);
                    }

                    // ── Market phase for this tick ─────────────────────────────
                    LocalDateTime tickLDT  = toLDT(epochMs);
                    String        phase    = marketPhase(tickLDT, closeoutMins);
                    boolean       tradable = "TRADING".equals(phase);

                    // Detect 15:30 crossing → force-close once
                    if ("CLOSED".equals(phase) && !marketClosed) {
                        marketClosed = true;
                        if (execEngine.getState() != OptionExecutionEngine.PositionState.FLAT) {
                            execEngine.forceClose(selectorService, tickLDT);
                            log.info("Tick replay session {}: force-close at market close ({})", sessionId, tickLDT);
                        }
                    }

                    // Emit raw tick event (updates live ticker in UI)
                    emitTickEvent(token, ltp, epochMs, forming, niftyToken);

                    // Evaluate + emit candle event on every NIFTY tick
                    OptionsLiveService.FormingCandle fc = forming.get(token);
                    if (fc != null) {
                        emittedCount = emitCandleEvent(
                                fc, bucketMs, epochMs, decisionEngine, selectorService,
                                execEngine, currentRegime, emittedCount, cePool, pePool,
                                phase, tradable, forming, liveOptionCandles, optionTokens);
                    }

                } else if (optionTokens.contains(token)) {
                    OptionsLiveService.FormingCandle cur = forming.get(token);
                    if (cur == null) {
                        forming.put(token, new OptionsLiveService.FormingCandle(ltp, vol, bucketMs));
                    } else if (bucketMs > cur.startMs) {
                        CandleDto closed = cur.toCandle(toLDT(cur.startMs));
                        forming.put(token, new OptionsLiveService.FormingCandle(ltp, vol, bucketMs));
                        NavigableMap<LocalDateTime, CandleDto> map = liveOptionCandles.get(token);
                        if (map != null) map.put(closed.openTime(), closed);
                    } else {
                        cur.update(ltp, vol);
                    }
                    emitTickEvent(token, ltp, epochMs, forming, niftyToken);
                }

                // Speed control
                if (realTimedReplay) {
                    long sessionElapsedMs = epochMs - firstTickMs;
                    long targetWallMs     = startWallMs + (long) (sessionElapsedMs / req.getSpeedMultiplier());
                    long sleepMs          = targetWallMs - System.currentTimeMillis();
                    if (sleepMs > 0) Thread.sleep(sleepMs);
                }
            }

            if (stopped) return;

            // ── 5. Force-close any open position ──────────────────────────────
            if (execEngine.getState() != OptionExecutionEngine.PositionState.FLAT
                    && !ticks.isEmpty()) {
                LocalDateTime lastTime = toLDT(ticks.get(ticks.size() - 1).tickTimeMs());
                execEngine.forceClose(selectorService, lastTime);
            }

            // ── 6. Summary ────────────────────────────────────────────────────
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("totalTrades",  execEngine.getClosedTrades().size());
            summary.put("realizedPnl",  execEngine.getRealizedPnl());
            summary.put("finalCapital", execEngine.getCapital());
            summary.put("closedTrades", execEngine.getClosedTrades());
            summary.put("emittedCount", emittedCount);
            broadcast("summary", objectMapper.writeValueAsString(summary));

            decisionEngine.cleanup();
            log.info("Tick replay session {} complete: {} ticks, {} emitted, {} trades",
                    sessionId, ticks.size(), emittedCount, execEngine.getClosedTrades().size());
        }

        // ── tick event (raw LTP update for live ticker) ───────────────────────

        private void emitTickEvent(long token, double ltp, long epochMs,
                                   Map<Long, OptionsLiveService.FormingCandle> forming,
                                   long niftyToken) {
            if (emitters.isEmpty()) return;
            try {
                boolean isNifty = (token == niftyToken);
                OptionsLiveService.FormingCandle fc = forming.get(token);

                Map<String, Object> evt = new LinkedHashMap<>();
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
                // Tick events are NOT buffered — high frequency, no replay needed
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

        // ── candle event (decision + execution result) ────────────────────────

        private int emitCandleEvent(OptionsLiveService.FormingCandle fc,
                                    long bucketMs, long tickEpochMs,
                                    NiftyDecisionEngine decisionEngine,
                                    OptionSelectorService selectorService,
                                    OptionExecutionEngine execEngine,
                                    String regime, int emittedCount,
                                    List<OptionsReplayRequest.OptionCandidate> cePool,
                                    List<OptionsReplayRequest.OptionCandidate> pePool,
                                    String marketPhase, boolean tradable,
                                    Map<Long, OptionsLiveService.FormingCandle> forming,
                                    Map<Long, NavigableMap<LocalDateTime, CandleDto>> liveOptionCandles,
                                    Set<Long> optionTokens) {
            try {
                LocalDateTime openTime = toLDT(bucketMs);
                CandleDto snapshot = fc.toCandle(openTime);

                // Always evaluate for warmup/scoring regardless of phase
                NiftyDecisionResult decision = decisionEngine.evaluateTick(snapshot, regime);
                OptionsLiveService.applyTradingRules(decision, regime, req.getTradingRules());
                OptionsLiveService.applyScoreTierRules(decision, regime,
                        req.getTradeQualityConfig(), execEngine.getBarsSinceLastLoss());

                double niftyClose = snapshot.close().doubleValue();

                // Gate execution based on market phase
                String action;
                if ("CLOSED".equals(marketPhase)) {
                    // Force-close already done in run() — just record as HELD
                    action = execEngine.getState() != OptionExecutionEngine.PositionState.FLAT
                            ? execEngine.process(decision, selectorService, cePool, pePool, niftyClose, openTime, snapshot)
                            : "—";
                } else if (!tradable && execEngine.getState() == OptionExecutionEngine.PositionState.FLAT) {
                    // PRE_MARKET or CLOSING with no open position — block new entries
                    action = "HOLD";
                } else {
                    // TRADING phase, or in-position during CLOSING (manage/exit existing)
                    action = execEngine.process(decision, selectorService,
                            cePool, pePool, niftyClose, openTime, snapshot);
                }

                emittedCount++;
                CandleDto optCandle = execEngine.getActiveToken() != null
                        ? selectorService.getCandle(execEngine.getActiveToken(), openTime) : null;

                OptionsReplayCandleEvent event = buildEvent(
                        emittedCount, snapshot, decision, execEngine, selectorService,
                        openTime, action, optCandle, marketPhase, tradable);

                broadcast("candle", objectMapper.writeValueAsString(event));

                // ── divergence debug (log.debug — enable via logging.level.com.sma=DEBUG) ─
                if (log.isDebugEnabled()) {
                    logCandleDebug("REPLAY", sessionId, tickEpochMs, bucketMs, event, forming,
                            liveOptionCandles, optionTokens);
                }

            } catch (Exception e) {
                log.debug("Tick replay session {}: candle event failed: {}", sessionId, e.getMessage());
            }
            return emittedCount;
        }

        // ── divergence debug helper ───────────────────────────────────────────

        /**
         * Logs every NIFTY evaluation point so live and replay logs can be diffed line-by-line.
         * Enabled only at DEBUG level — no performance cost in production.
         *
         * <p>Also logs option snapshot state for each CE/PE token at this bucket so you can
         * see exactly what price data the selector had (or didn't have) at decision time.
         */
        private static void logCandleDebug(String mode, String sessionId,
                long tickEpochMs, long bucketMs,
                OptionsReplayCandleEvent e,
                Map<Long, OptionsLiveService.FormingCandle> forming,
                Map<Long, NavigableMap<LocalDateTime, CandleDto>> liveOptionCandles,
                Set<Long> optionTokens) {

            log.debug("[{}][{}] tick={} bucket={} niftyTime={} regime={} bias={} winner={} score={} " +
                            "entryAllowed={} blockReason={} execWait={} state={} action={} " +
                            "token={} symbol={} entryPx={} capital={}",
                    mode, sessionId,
                    tickEpochMs, bucketMs,
                    e.getNiftyTime(),
                    e.getRegime(),
                    e.getConfirmedBias(),
                    e.getWinnerStrategy(),
                    String.format("%.2f", e.getWinnerScore()),
                    e.isEntryAllowed(),
                    e.getBlockReason()    != null ? e.getBlockReason()    : "-",
                    e.getExecWaitReason() != null ? e.getExecWaitReason() : "-",
                    e.getPositionState(),
                    e.getAction(),
                    e.getSelectedToken()          != null ? e.getSelectedToken()         : "-",
                    e.getSelectedTradingSymbol()   != null ? e.getSelectedTradingSymbol()  : "-",
                    String.format("%.2f", e.getEntryPrice()),
                    String.format("%.2f", e.getCapital()));

            // Log option snapshot state for every CE/PE token
            java.time.LocalDateTime bucketLdt = toLDT(bucketMs);
            for (Long token : optionTokens) {
                NavigableMap<java.time.LocalDateTime, CandleDto> map =
                        liveOptionCandles != null ? liveOptionCandles.get(token) : null;
                OptionsLiveService.FormingCandle forming_ = forming != null ? forming.get(token) : null;
                boolean hasSameBucket = forming_ != null && forming_.startMs == bucketMs;
                CandleDto snap = map != null ? map.get(bucketLdt) : null;
                log.debug("[{}][{}]   opt-snap token={} bucketMs={} hasSameBucketForming={} " +
                                "snapPresent={} O={} H={} L={} C={}",
                        mode, sessionId,
                        token, bucketMs,
                        hasSameBucket,
                        snap != null,
                        snap != null ? snap.open()  : "-",
                        snap != null ? snap.high()  : "-",
                        snap != null ? snap.low()   : "-",
                        snap != null ? snap.close() : "-");
            }
        }

        private int warmupOptionCandles(OptionsReplayRequest.OptionCandidate c,
                                        LocalDateTime from, LocalDateTime to,
                                        Map<Long, NavigableMap<LocalDateTime, CandleDto>> liveOptionCandles) {
            if (c.getInstrumentToken() == null) return 0;
            try {
                List<CandleDto> candles = dataEngineClient.fetchHistory(
                        new DataEngineClient.HistoryRequest(
                                req.getUserId(), req.getBrokerName(),
                                c.getInstrumentToken(),
                                c.getTradingSymbol() != null ? c.getTradingSymbol() : "",
                                c.getExchange()      != null ? c.getExchange()      : "NFO",
                                req.getInterval(), from, to, false));
                NavigableMap<LocalDateTime, CandleDto> map = liveOptionCandles.get(c.getInstrumentToken());
                if (map != null) {
                    for (CandleDto candle : candles) map.put(candle.openTime(), candle);
                }
                return candles.size();
            } catch (Exception e) {
                log.warn("Tick replay session {}: option pre-warm failed for {} ({}): {}",
                        sessionId, c.getTradingSymbol(), c.getInstrumentToken(), e.getMessage());
                return 0;
            }
        }

        private String marketPhase(LocalDateTime tickTime, int closeoutMins) {
            LocalTime t = tickTime.toLocalTime();
            if (t.isBefore(MARKET_OPEN))   return "PRE_MARKET";
            if (!t.isBefore(MARKET_CLOSE)) return "CLOSED";
            if (closeoutMins > 0 && !t.isBefore(MARKET_CLOSE.minusMinutes(closeoutMins))) return "CLOSING";
            return "TRADING";
        }

        // ── option candle snapshot (same-bucket only — matches live behaviour exactly) ──

        /**
         * Snapshots the current forming state of each option token into
         * {@code liveOptionCandles} for {@code bucketMs}.
         *
         * <p><b>Intentionally no forward-fill.</b>
         * Live ({@link OptionsLiveService#snapshotOptionCandles}) only writes a snapshot
         * when the option's {@code FormingCandle.startMs == closedBucketMs}; it never
         * synthesises data from prior candles.  Replay must mirror this exactly so that
         * {@link com.sma.strategyengine.service.options.OptionSelectorService#getCandle}
         * returns the same result (or absence of result) in both modes.
         * Divergence in snapshot content is the primary source of entry-price mismatch.
         */
        private static void snapshotOptionCandles(
                long bucketMs, LocalDateTime bucketTime,
                Map<Long, OptionsLiveService.FormingCandle> forming,
                Map<Long, NavigableMap<LocalDateTime, CandleDto>> liveOptionCandles,
                Set<Long> optionTokens, long ivMs) {
            for (Long token : optionTokens) {
                NavigableMap<LocalDateTime, CandleDto> map = liveOptionCandles.get(token);
                if (map == null) continue;
                OptionsLiveService.FormingCandle opt = forming.get(token);
                if (opt != null && opt.startMs == bucketMs) {
                    // Option is in the same bucket — snapshot forming state (partial candle)
                    CandleDto snap = new CandleDto(
                            bucketTime,
                            BigDecimal.valueOf(opt.open), BigDecimal.valueOf(opt.high),
                            BigDecimal.valueOf(opt.low),  BigDecimal.valueOf(opt.close),
                            opt.volume);
                    map.put(snap.openTime(), snap);
                }
                // No forward-fill: if the option has no tick in this bucket yet,
                // leave the map entry absent — same as live.
            }
        }

        // ── regime helpers ────────────────────────────────────────────────────

        private static String computeRegime(BacktestRequest.RegimeConfig rc,
                                            List<Double> highs, List<Double> lows, List<Double> closes) {
            if (rc == null || !rc.isEnabled()) return "RANGING";
            int minRequired = rc.getAdxPeriod() * 2 + 1;
            if (highs.size() < minRequired) return "RANGING";
            double[] H = highs.stream().mapToDouble(Double::doubleValue).toArray();
            double[] L = lows.stream().mapToDouble(Double::doubleValue).toArray();
            double[] C = closes.stream().mapToDouble(Double::doubleValue).toArray();
            MarketRegimeDetector.Regime[] regimes = MarketRegimeDetector.computeAll(
                    H, L, C, rc.getAdxPeriod(), rc.getAtrPeriod(),
                    rc.getAdxTrendThreshold(), rc.getAtrVolatilePct(), rc.getAtrCompressionPct());
            int last = regimes.length - 1;
            return (last >= 0 && regimes[last] != null) ? regimes[last].name() : "RANGING";
        }

        private static void keepRegimeBounded(List<Double> highs, List<Double> lows, List<Double> closes) {
            while (highs.size() > 2000) {
                highs.remove(0);
                lows.remove(0);
                closes.remove(0);
            }
        }

        // ── engine builders ───────────────────────────────────────────────────

        private NiftyDecisionEngine buildDecisionEngine() {
            return new NiftyDecisionEngine(
                    strategyRegistry,
                    req.getStrategies(),
                    Optional.ofNullable(req.getDecisionConfig())
                            .orElse(new OptionsReplayRequest.DecisionConfig()),
                    Optional.ofNullable(req.getSwitchConfig())
                            .orElse(new OptionsReplayRequest.SwitchConfig()),
                    Optional.ofNullable(req.getRegimeRules())
                            .orElse(new OptionsReplayRequest.RegimeRules()),
                    Optional.ofNullable(req.getRegimeStrategyRules())
                            .orElse(new OptionsReplayRequest.RegimeStrategyRules()),
                    Optional.ofNullable(req.getChopRules())
                            .orElse(new OptionsReplayRequest.ChopRules()),
                    Optional.ofNullable(req.getRangeQualityConfig())
                            .orElse(new OptionsReplayRequest.RangeQualityConfig()),
                    Optional.ofNullable(req.getTradeQualityConfig())
                            .orElse(new OptionsReplayRequest.TradeQualityConfig()),
                    Optional.ofNullable(req.getTrendEntryConfig())
                            .orElse(new OptionsReplayRequest.TrendEntryConfig()),
                    Optional.ofNullable(req.getCompressionEntryConfig())
                            .orElse(new OptionsReplayRequest.CompressionEntryConfig()),
                    Optional.ofNullable(req.getPenaltyConfig())
                            .orElse(new OptionsReplayRequest.PenaltyConfig()));
        }

        private OptionsReplayRequest buildExecRequest() {
            OptionsReplayRequest r = new OptionsReplayRequest();
            r.setInitialCapital(BigDecimal.valueOf(req.getInitialCapital()));
            r.setQuantity(req.getQuantity());
            r.setDecisionConfig(Optional.ofNullable(req.getDecisionConfig())
                    .orElse(new OptionsReplayRequest.DecisionConfig()));
            r.setSwitchConfig(Optional.ofNullable(req.getSwitchConfig())
                    .orElse(new OptionsReplayRequest.SwitchConfig()));
            r.setHoldConfig(Optional.ofNullable(req.getHoldConfig())
                    .orElse(new OptionsReplayRequest.HoldConfig()));
            r.setRiskConfig(Optional.ofNullable(req.getRiskConfig())
                    .orElse(new OptionsReplayRequest.RiskConfig()));
            r.setExitConfig(Optional.ofNullable(req.getExitConfig())
                    .orElse(new OptionsReplayRequest.ExitConfig()));
            return r;
        }

        // ── event builder ─────────────────────────────────────────────────────

        private OptionsReplayCandleEvent buildEvent(int emitted, CandleDto nifty,
                                                    NiftyDecisionResult decision,
                                                    OptionExecutionEngine exec,
                                                    OptionSelectorService selector,
                                                    LocalDateTime candleTime,
                                                    String action,
                                                    CandleDto optCandle,
                                                    String marketPhase,
                                                    boolean tradable) {
            return OptionsReplayCandleEvent.builder()
                    .emitted(emitted).total(0)
                    // niftyTime = bucket start, identical to live — required for compare-tab key matching
                    .niftyTime(nifty.openTime() != null ? nifty.openTime().toString() : null)
                    .niftyOpen(nifty.open().doubleValue())
                    .niftyHigh(nifty.high().doubleValue())
                    .niftyLow(nifty.low().doubleValue())
                    .niftyClose(nifty.close().doubleValue())
                    .niftyVolume(nifty.volume() != null ? nifty.volume() : 0L)
                    .niftyBias(decision.getRawBias()       != null ? decision.getRawBias().name()       : "NEUTRAL")
                    .previousNiftyBias(decision.getPreviousBias() != null ? decision.getPreviousBias().name() : "NEUTRAL")
                    .confirmedBias(decision.getConfirmedBias()    != null ? decision.getConfirmedBias().name() : "NEUTRAL")
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
                    .positionState(exec.getState() != null ? exec.getState().name() : "FLAT")
                    .desiredSide(exec.getDesiredSide() != null ? exec.getDesiredSide().name() : "NONE")
                    .action(action)
                    .exitReason(exec.getLastExitReason())
                    .entryRegime(exec.getEntryRegime())
                    .appliedMinHold(exec.getAppliedMinHold())
                    .holdActive(exec.isHoldActive())
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
                    .closedTrades(new ArrayList<>(exec.getClosedTrades()))
                    .build();
        }

        private static List<OptionsReplayCandleEvent.CandidateScore> toCandidateEvents(
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

        // ── helpers ───────────────────────────────────────────────────────────

        private static LocalDateTime toLDT(long epochMs) {
            return Instant.ofEpochMilli(epochMs).atZone(IST).toLocalDateTime();
        }
    }
}
