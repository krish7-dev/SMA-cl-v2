package com.sma.strategyengine.service.options;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.client.AiEngineClient;
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
    private final AiEngineClient            aiEngineClient;

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

        // Rolling recent-candle buffer for AI payload context (last ≤5 completed candles)
        private final java.util.Deque<java.util.Map<String, Object>> recentCandleBuffer
                = new java.util.ArrayDeque<>(6);
        private double                lastCandleClose        = 0.0;  // latest tick close (updated every tick)
        private double                prevBucketClose        = 0.0;  // last close of previous bucket (for moveFromPrevClose)
        private java.time.LocalDateTime lastBufferedCandleTime = null; // guards against same-bucket duplicate entries

        // AI call tracking — attempted incremented synchronously; succeeded/failed updated via future callbacks
        private int aiAdvisoriesAttempted   = 0;
        private int aiAdvisoriesPostSucceeded = 0;
        private int aiAdvisoriesPostFailed  = 0;
        private int aiReviewsAttempted      = 0;
        private int aiReviewsPostSucceeded  = 0;
        private int aiReviewsPostFailed     = 0;
        // Futures collected for bounded end-of-replay wait
        private final java.util.List<java.util.concurrent.CompletableFuture<Boolean>> pendingAiFutures
                = new java.util.concurrent.CopyOnWriteArrayList<>();

        // Regime price buffers — promoted to instance fields so AI payload builders can access them
        private List<Double> regimeHighs  = new ArrayList<>();
        private List<Double> regimeLows   = new ArrayList<>();
        private List<Double> regimeCloses = new ArrayList<>();

        volatile boolean stopped = false;

        // Captured at run() completion — used by autoSave() since execEngine is local to run()
        volatile String finalClosedTradesJson;
        volatile double finalRealizedPnl;
        volatile double finalCapital = 100_000.0;

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

        /** Strips closedTrades and candidates for DB storage — SSE broadcast still sends the full event. */
        private String toChunkJson(OptionsReplayCandleEvent event) {
            try {
                return objectMapper.writeValueAsString(
                        event.toBuilder().closedTrades(null).candidates(null).build());
            } catch (Exception e) {
                log.warn("TICK_REPLAY toChunkJson failed session={}: {}", sessionId, e.getMessage());
                try { return objectMapper.writeValueAsString(event); } catch (Exception ex) { return "{}"; }
            }
        }

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
                log.debug("TICK_REPLAY chunk persisted: sessionId={} chunk={} bytes={}",
                        sessionId, emittedChunks, json.length());
            } catch (Exception e) {
                log.warn("TICK_REPLAY chunk persist failed: sessionId={} size={} error={}",
                        sessionId, chunkBuffer.size(), e.getMessage());
            }
            chunkBuffer.clear();
        }

        void autoSave() {
            if (!req.isSaveForCompare()) return;
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
                summaryMap.put("realizedPnl",         finalRealizedPnl);
                summaryMap.put("finalCapital",        finalCapital);
                summaryMap.put("sessionEnd",          Instant.now().toString());
                sessionPersistenceService.updateMetadata(
                        sessionId, finalClosedTradesJson,
                        objectMapper.writeValueAsString(summaryMap),
                        objectMapper.writeValueAsString(req), "");
                log.info("TICK_REPLAY auto-saved: sessionId={} chunks={}", sessionId, emittedChunks);
            } catch (Exception e) {
                log.error("TICK_REPLAY auto-save metadata failed: sessionId={} error={}", sessionId, e.getMessage());
            }
        }

        private void broadcast(String eventName, String data) {
            broadcast(eventName, data, null);
        }

        /**
         * @param data      Full event JSON — sent to SSE emitters unchanged.
         * @param chunkData Compact event JSON (closedTrades/candidates stripped) — stored in session_feed_chunk.
         *                  If null, falls back to data for storage (non-candle events).
         */
        private void broadcast(String eventName, String data, String chunkData) {
            if ("candle".equals(eventName) || "init".equals(eventName) || "summary".equals(eventName) || "warning".equals(eventName)) {
                synchronized (bufferLock) {
                    if (eventBuffer.size() >= BUFFER_SIZE) eventBuffer.pollFirst();
                    eventBuffer.addLast(new String[]{ eventName, data });
                }
            }
            // Persist compact chunkData (closedTrades/candidates stripped) to avoid repeated bloat.
            // saveForCompare gate is unchanged — no chunks written when false.
            if (req.isSaveForCompare() && "candle".equals(eventName)) {
                chunkBuffer.add(chunkData != null ? chunkData : data);
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

            // Capture final state so autoSave() can use it (execEngine is local to run())
            if (req.isSaveForCompare()) {
                try {
                    finalClosedTradesJson = objectMapper.writeValueAsString(execEngine.getClosedTrades());
                    finalRealizedPnl      = execEngine.getRealizedPnl();
                    finalCapital          = execEngine.getCapital();
                } catch (Exception e) {
                    log.warn("Tick replay {}: failed to capture final state for save: {}", sessionId, e.getMessage());
                }
            }

            // ── 6. Bounded wait for pending AI posts (max 10 s) ─────────────────
            int aiPending = 0;
            if (req.isAiEnabled() && !pendingAiFutures.isEmpty()) {
                try {
                    java.util.concurrent.CompletableFuture
                            .allOf(pendingAiFutures.toArray(new java.util.concurrent.CompletableFuture[0]))
                            .get(10, java.util.concurrent.TimeUnit.SECONDS);
                } catch (java.util.concurrent.TimeoutException te) {
                    aiPending = (int) pendingAiFutures.stream().filter(f -> !f.isDone()).count();
                    log.warn("Tick replay {}: {} AI post(s) still pending after 10 s timeout", sessionId, aiPending);
                } catch (Exception ignored) {}
            }

            // ── 7. Summary ────────────────────────────────────────────────────
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("totalTrades",  execEngine.getClosedTrades().size());
            summary.put("realizedPnl",  execEngine.getRealizedPnl());
            summary.put("finalCapital", execEngine.getCapital());
            summary.put("closedTrades", execEngine.getClosedTrades());
            summary.put("emittedCount", emittedCount);
            summary.put("aiAdvisoriesAttempted",    aiAdvisoriesAttempted);
            summary.put("aiAdvisoriesPostSucceeded", aiAdvisoriesPostSucceeded);
            summary.put("aiAdvisoriesPostFailed",   aiAdvisoriesPostFailed);
            summary.put("aiAdvisoriesPending",      aiPending > 0 ? aiPending : 0);
            summary.put("aiReviewsAttempted",       aiReviewsAttempted);
            summary.put("aiReviewsPostSucceeded",   aiReviewsPostSucceeded);
            summary.put("aiReviewsPostFailed",      aiReviewsPostFailed);
            summary.put("aiReviewsPending",         aiPending > 0 ? aiPending : 0);
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

                // Notify decision engine of any cascade-eligible exit
                if (execEngine.getLastExitReason() != null) {
                    java.util.List<com.sma.strategyengine.model.response.OptionsReplayCandleEvent.ClosedTrade> ct = execEngine.getClosedTrades();
                    String exitSide = ct.isEmpty() ? null : ct.get(ct.size() - 1).getOptionType();
                    decisionEngine.recordCascadeExit(execEngine.getLastExitReason(), "NIFTY", exitSide, openTime);
                    // Review fires here — catches ALL exits including BIAS_REVERSAL_STRONG
                    if (req.isAiEnabled() && !ct.isEmpty()) {
                        aiReviewsAttempted++;
                        java.util.concurrent.CompletableFuture<Boolean> rf =
                                aiEngineClient.reviewAsync(buildReviewPayload(decision, execEngine, ct.get(ct.size() - 1)));
                        pendingAiFutures.add(rf);
                        rf.whenComplete((ok, ex) -> {
                            if (ex != null || Boolean.FALSE.equals(ok)) aiReviewsPostFailed++;
                            else aiReviewsPostSucceeded++;
                        });
                    }
                }

                // Update recent candle buffer before AI payload builders so current candle
                // is the last element in recentCandles for both advisory and review payloads.
                // Within a bucket, the last entry is replaced (not duplicated) so recentCandles
                // always has ≤5 unique bucket times and reflects the latest forming state.
                {
                    double o = snapshot.open().doubleValue(),  h = snapshot.high().doubleValue(),
                           lo = snapshot.low().doubleValue(),  c = snapshot.close().doubleValue();
                    boolean isNewBucket = !openTime.equals(lastBufferedCandleTime);
                    if (isNewBucket) {
                        // Entering a new bucket: save the previous bucket's final close for moveFromPrevClose
                        prevBucketClose = lastCandleClose;
                        lastBufferedCandleTime = openTime;
                    }
                    java.util.Map<String, Object> cc = new java.util.HashMap<>();
                    cc.put("time",      openTime.toLocalTime().toString().substring(0, 5));
                    cc.put("direction", c > o ? "UP" : (c < o ? "DOWN" : "DOJI"));
                    cc.put("bodyPctOfRange",  (h - lo) > 0 ? Math.abs(c - o) / (h - lo) * 100.0 : 0.0);
                    cc.put("bodyPctOfPrice",  o != 0 ? Math.abs(c - o) / o * 100.0 : 0.0);
                    cc.put("closePositionInRange", (h - lo) > 0 ? (c - lo) / (h - lo) : 0.5);
                    cc.put("vwapDistancePct", decision.getDistanceFromVwap());
                    if (prevBucketClose > 0) {
                        cc.put("moveFromPrevClosePct", (c - prevBucketClose) / prevBucketClose * 100.0);
                    }
                    if (isNewBucket) {
                        recentCandleBuffer.addLast(cc);
                        if (recentCandleBuffer.size() > 5) recentCandleBuffer.pollFirst();
                    } else if (!recentCandleBuffer.isEmpty()) {
                        // Replace last entry with latest forming state for same bucket
                        recentCandleBuffer.pollLast();
                        recentCandleBuffer.addLast(cc);
                    }
                    lastCandleClose = c; // always track latest tick close for next bucket's prevBucketClose
                }

                // Non-blocking AI advisory (future tracked for end-of-replay reporting)
                if (req.isAiEnabled() && "ENTERED".equals(action)) {
                    aiAdvisoriesAttempted++;
                    java.util.concurrent.CompletableFuture<Boolean> af =
                            aiEngineClient.adviseAsync(buildAdvisoryPayload(decision, execEngine, snapshot, openTime));
                    pendingAiFutures.add(af);
                    af.whenComplete((ok, ex) -> {
                        if (ex != null || Boolean.FALSE.equals(ok)) aiAdvisoriesPostFailed++;
                        else aiAdvisoriesPostSucceeded++;
                    });
                }

                emittedCount++;
                CandleDto optCandle = execEngine.getActiveToken() != null
                        ? selectorService.getCandle(execEngine.getActiveToken(), openTime) : null;

                OptionsReplayCandleEvent event = buildEvent(
                        emittedCount, snapshot, decision, execEngine, selectorService,
                        openTime, action, optCandle, marketPhase, tradable);

                String fullJson  = objectMapper.writeValueAsString(event);
                String chunkJson = req.isSaveForCompare() ? toChunkJson(event) : null;
                broadcast("candle", fullJson, chunkJson);

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

        // ── AI payload builders ───────────────────────────────────────────────

        private java.util.Map<String, Object> buildAdvisoryPayload(
                NiftyDecisionResult decision, OptionExecutionEngine execEngine,
                CandleDto snapshot, java.time.LocalDateTime openTime) {
            java.util.Map<String, Object> m = new java.util.HashMap<>();
            m.put("sessionId", sessionId);
            String sym = execEngine.getActiveTradingSymbol();
            m.put("symbol", sym != null ? sym : "NIFTY");
            String optType = execEngine.getActiveOptionType();
            if (optType == null) optType = deriveOptionType(sym);  // fallback: read suffix from symbol
            m.put("side", "LONG_OPTION");  // both CE and PE are long positions
            m.put("currentOptionType", optType);
            m.put("candleTime", openTime.atZone(IST).toInstant().toString());
            m.put("entryPrice", execEngine.getEntryPrice());
            m.put("quantity", execEngine.getQuantity());
            m.put("regime", decision.getRegime());
            m.put("winningStrategy", decision.getWinnerStrategy());
            m.put("winningScore", decision.getWinnerScore());
            m.put("oppositeScore", decision.getSecondScore());
            m.put("scoreGap", decision.getScoreGap());
            m.put("recentMove3CandlePct", decision.getRecentMove3());
            m.put("recentMove5CandlePct", decision.getRecentMove5());
            m.put("vwapDistancePct", decision.getDistanceFromVwap());
            if (snapshot.open() != null && snapshot.close() != null
                    && snapshot.open().doubleValue() != 0) {
                m.put("candleBodyPct", Math.abs(snapshot.close().doubleValue() - snapshot.open().doubleValue())
                        / snapshot.open().doubleValue() * 100.0);
            }
            m.put("optionPremium", execEngine.getEntryPrice());
            m.put("barsSinceLastTrade", execEngine.getBarsSinceLastTrade());
            m.put("capitalBefore", execEngine.getCapital());
            // ADX / ATR from regime buffers (computed at payload time, not in tick path)
            try {
                double[] adxAtr = com.sma.strategyengine.service.MarketRegimeDetector
                        .computeLastAdxAndAtr(toDoubleArray(regimeHighs), toDoubleArray(regimeLows), toDoubleArray(regimeCloses));
                m.put("adx",    adxAtr[0]);
                m.put("atrPct", adxAtr[1]);
            } catch (Exception ignored) {}
            // Filter pass/fail
            m.put("minMovementFilterPassed",      decision.getMinMovementFilterPassed());
            m.put("directionalConsistencyPassed", decision.getDirectionalConsistencyPassed());
            m.put("candleStrengthFilterPassed",   decision.getCandleStrengthFilterPassed());
            // Session context
            m.put("compressionNoTradeEnabled",
                    req.getTradingRules() != null && req.getTradingRules().isCompressionNoTrade());
            java.util.List<com.sma.strategyengine.model.response.OptionsReplayCandleEvent.ClosedTrade> allTrades
                    = execEngine.getClosedTrades();
            m.put("tradesToday",        allTrades.size());
            m.put("dailyPnlBeforeTrade", execEngine.getRealizedPnl());
            // Previous trade context
            if (!allTrades.isEmpty()) {
                com.sma.strategyengine.model.response.OptionsReplayCandleEvent.ClosedTrade prev
                        = allTrades.get(allTrades.size() - 1);
                String prevOptType = prev.getOptionType();
                if (prevOptType == null) prevOptType = deriveOptionType(prev.getTradingSymbol());
                boolean strongWin  = prev.getPnlPct() >= 8.0;
                m.put("previousTradeSymbol",             prev.getTradingSymbol());
                m.put("previousTradeOptionType",         prevOptType);
                m.put("previousTradePnlPct",             prev.getPnlPct());
                m.put("previousTradeExitReason",         prev.getExitReason());
                m.put("previousTradeExitTime",           prev.getExitTime());
                m.put("previousTradeWasStrongWinner",    strongWin);
                m.put("isOppositeSideAfterStrongWinner",
                        strongWin && optType != null && prevOptType != null && !optType.equals(prevOptType));
                try {
                    java.time.LocalDateTime prevExit = java.time.LocalDateTime.parse(prev.getExitTime());
                    m.put("minutesSincePreviousExit",
                            (int) java.time.Duration.between(prevExit, openTime).toMinutes());
                } catch (Exception ignored) {}
            }
            // Recent candle context (current candle is last element — buffer updated before this call)
            m.put("recentCandles", new java.util.ArrayList<>(recentCandleBuffer));

            // ── Derived fields for AI reversal-trap intelligence ───────────────
            {
                java.util.List<java.util.Map<String, Object>> rc = new java.util.ArrayList<>(recentCandleBuffer);
                int upCnt = 0, downCnt = 0, strongUpCnt = 0, strongDownCnt = 0;
                for (java.util.Map<String, Object> c : rc) {
                    String dir = (String) c.getOrDefault("direction", "DOJI");
                    Object bpObj = c.get("bodyPctOfRange");
                    double bp = bpObj instanceof Number ? ((Number) bpObj).doubleValue() : 0.0;
                    if ("UP".equals(dir))        { upCnt++;   if (bp > 60) strongUpCnt++;   }
                    else if ("DOWN".equals(dir)) { downCnt++; if (bp > 60) strongDownCnt++; }
                }
                String domDir = upCnt > downCnt ? "UP" : downCnt > upCnt ? "DOWN" : "MIXED";
                double domStrength = rc.isEmpty() ? 0.0 : (double) Math.max(upCnt, downCnt) / rc.size();
                m.put("recentUpCandles",                upCnt);
                m.put("recentDownCandles",              downCnt);
                m.put("recentStrongUpCandles",          strongUpCnt);
                m.put("recentStrongDownCandles",        strongDownCnt);
                m.put("dominantRecentDirection",        domDir);
                m.put("dominantRecentDirectionStrength", domStrength);
                // currentTradeDirection: CE=BULLISH, PE=BEARISH
                String ctDir = "CE".equals(optType) ? "BULLISH" : "PE".equals(optType) ? "BEARISH" : null;
                m.put("currentTradeDirection", ctDir);
                m.put("currentTradeAlignedWithRecentDirection",
                        ("BULLISH".equals(ctDir) && "UP".equals(domDir)) ||
                        ("BEARISH".equals(ctDir) && "DOWN".equals(domDir)));
                Object minsObj = m.get("minutesSincePreviousExit");
                int mins = minsObj instanceof Number ? ((Number) minsObj).intValue() : -1;
                boolean isOpp  = Boolean.TRUE.equals(m.get("isOppositeSideAfterStrongWinner"));
                boolean wasWin = Boolean.TRUE.equals(m.get("previousTradeWasStrongWinner"));
                m.put("sameCandleFlip",           isOpp && mins == 0);
                m.put("candlesSincePreviousExit", mins >= 0 ? mins / 5 : null);
                m.put("oppositeSideFlipRisk",
                        (isOpp && wasWin && mins >= 0 && mins <= 1) ? "HIGH" :
                        (isOpp && wasWin) ? "MEDIUM" : "LOW");
                m.put("reversalConfirmationCandles",
                        "BEARISH".equals(ctDir) ? strongDownCnt : "BULLISH".equals(ctDir) ? strongUpCnt : 0);
                // Explicit direction facts — prevents AI hallucination about CE/PE direction
                m.put("favorableUnderlyingDirection",
                        "CE".equals(optType) ? "UP" : "PE".equals(optType) ? "DOWN" : null);
                m.put("currentTradeDirectionExplanation",
                        "CE".equals(optType) ? "CE (Call) benefits when NIFTY moves UP. UP candles are favorable." :
                        "PE".equals(optType) ? "PE (Put) benefits when NIFTY moves DOWN. DOWN candles are favorable." : null);

                // Precomputed candle alignment — AI must use these instead of re-deriving from raw candles
                // PE is bearish: DOWN candles support, UP candles oppose.
                // CE is bullish: UP candles support, DOWN candles oppose.
                m.put("instrumentContext", "UNDERLYING");
                int supportCount = "CE".equals(optType) ? upCnt : "PE".equals(optType) ? downCnt : 0;
                int opposeCount  = "CE".equals(optType) ? downCnt : "PE".equals(optType) ? upCnt : 0;
                m.put("recentCandlesSupportTradeCount", supportCount);
                m.put("recentCandlesOpposeTradeCount",  opposeCount);
                boolean lastSupports = false;
                if (!rc.isEmpty()) {
                    String lastDir = (String) rc.get(rc.size() - 1).getOrDefault("direction", "DOJI");
                    lastSupports = ("CE".equals(optType) && "UP".equals(lastDir))
                               || ("PE".equals(optType) && "DOWN".equals(lastDir));
                }
                m.put("lastCandleSupportsTrade", lastSupports);
                String momentumAlignment = supportCount > opposeCount ? "SUPPORTS_TRADE"
                                         : opposeCount > supportCount ? "OPPOSES_TRADE"
                                         : "MIXED";
                m.put("recentMomentumAlignment", momentumAlignment);
            }
            return m;
        }

        private java.util.Map<String, Object> buildReviewPayload(
                NiftyDecisionResult decision,
                OptionExecutionEngine execEngine,
                com.sma.strategyengine.model.response.OptionsReplayCandleEvent.ClosedTrade ct) {
            java.util.Map<String, Object> m = new java.util.HashMap<>();
            String sId = sessionId;
            m.put("sessionId", sId);
            m.put("tradeId", sId + "-" + ct.getEntryTime());
            String sym = ct.getTradingSymbol();
            m.put("symbol", sym != null ? sym : "NIFTY");
            String curOptType = ct.getOptionType();
            if (curOptType == null) curOptType = deriveOptionType(sym);
            m.put("side", "LONG_OPTION");
            m.put("currentOptionType", curOptType);
            m.put("entryTime", ct.getEntryTime());
            m.put("exitTime", ct.getExitTime());
            m.put("entryPrice", ct.getEntryPrice());
            m.put("exitPrice", ct.getExitPrice());
            m.put("quantity", ct.getQuantity());
            m.put("pnl", ct.getPnl());
            m.put("pnlPct", ct.getPnlPct());
            m.put("exitReason", ct.getExitReason());
            m.put("barsHeld", ct.getBarsInTrade());
            m.put("regime", ct.getEntryRegime());
            m.put("winningStrategy", decision.getWinnerStrategy());
            m.put("winningScore", decision.getWinnerScore());
            m.put("scoreGap", decision.getScoreGap());
            m.put("recentMove3CandlePct", decision.getRecentMove3());
            m.put("recentMove5CandlePct", decision.getRecentMove5());
            m.put("vwapDistancePct", decision.getDistanceFromVwap());
            m.put("optionPremium", ct.getEntryPrice());
            // Capital before/after (capitalBefore derived: after - pnl)
            m.put("capitalAfter",  ct.getCapitalAfter());
            m.put("capitalBefore", ct.getCapitalAfter() - ct.getPnl());
            // MFE / MAE
            m.put("maxFavorableExcursionPct", ct.getMaxFavorableExcursionPct());
            m.put("maxAdverseExcursionPct",   ct.getMaxAdverseExcursionPct());
            // ADX / ATR from regime buffers (computed at payload time)
            try {
                double[] adxAtr = com.sma.strategyengine.service.MarketRegimeDetector
                        .computeLastAdxAndAtr(toDoubleArray(regimeHighs), toDoubleArray(regimeLows), toDoubleArray(regimeCloses));
                m.put("adx",    adxAtr[0]);
                m.put("atrPct", adxAtr[1]);
            } catch (Exception ignored) {}
            // Session context
            m.put("compressionNoTradeEnabled",
                    req.getTradingRules() != null && req.getTradingRules().isCompressionNoTrade());
            java.util.List<com.sma.strategyengine.model.response.OptionsReplayCandleEvent.ClosedTrade> allTrades
                    = execEngine.getClosedTrades();
            m.put("tradesToday", allTrades.size());
            m.put("dailyPnlAfterTrade",  execEngine.getRealizedPnl());
            m.put("dailyPnlBeforeTrade", execEngine.getRealizedPnl() - ct.getPnl());
            // Filter pass/fail (from the exit-candle decision)
            m.put("minMovementFilterPassed",      decision.getMinMovementFilterPassed());
            m.put("directionalConsistencyPassed", decision.getDirectionalConsistencyPassed());
            m.put("candleStrengthFilterPassed",   decision.getCandleStrengthFilterPassed());
            // Previous trade context (trade BEFORE this reviewed trade = second-to-last)
            if (allTrades.size() >= 2) {
                com.sma.strategyengine.model.response.OptionsReplayCandleEvent.ClosedTrade prev
                        = allTrades.get(allTrades.size() - 2);
                String prevOptType = prev.getOptionType();
                if (prevOptType == null) prevOptType = deriveOptionType(prev.getTradingSymbol());
                boolean strongWin  = prev.getPnlPct() >= 8.0;
                m.put("previousTradeSymbol",          prev.getTradingSymbol());
                m.put("previousTradeOptionType",      prevOptType);
                m.put("previousTradePnlPct",          prev.getPnlPct());
                m.put("previousTradeExitReason",      prev.getExitReason());
                m.put("previousTradeExitTime",        prev.getExitTime());
                m.put("previousTradeWasStrongWinner", strongWin);
                m.put("isOppositeSideAfterStrongWinner",
                        strongWin && curOptType != null && prevOptType != null && !curOptType.equals(prevOptType));
                try {
                    java.time.LocalDateTime prevExit  = java.time.LocalDateTime.parse(prev.getExitTime());
                    java.time.LocalDateTime thisEntry = java.time.LocalDateTime.parse(ct.getEntryTime());
                    m.put("minutesSincePreviousExit",
                            (int) java.time.Duration.between(prevExit, thisEntry).toMinutes());
                } catch (Exception ignored) {}
            }
            // Recent candle context (last ≤5 completed candles at time of exit)
            m.put("recentCandles", new java.util.ArrayList<>(recentCandleBuffer));

            // ── Derived fields for AI root-cause analysis ──────────────────────
            {
                double mfe = ct.getMaxFavorableExcursionPct();
                double mae = ct.getMaxAdverseExcursionPct();
                double pnlPctVal = ct.getPnlPct();
                int barsHeldVal = ct.getBarsInTrade();
                m.put("tradeHadFollowThrough", mfe >= 1.5);
                m.put("mfeQuality",  mfe < 0.5 ? "VERY_LOW" : mfe < 1.5 ? "LOW" : mfe < 4.0 ? "OK" : "STRONG");
                m.put("maeSeverity", mae <= -4.0 ? "HIGH" : mae <= -2.0 ? "MEDIUM" : "LOW");
                m.put("lossHappenedQuickly", pnlPctVal < 0 && barsHeldVal <= 3);
                // sameCandleFlip for review context (entry candle = same as previous exit candle)
                Object minsObj = m.get("minutesSincePreviousExit");
                int mins = minsObj instanceof Number ? ((Number) minsObj).intValue() : -1;
                m.put("sameCandleFlip", Boolean.TRUE.equals(m.get("isOppositeSideAfterStrongWinner")) && mins == 0);
                // Explicit direction facts — prevents AI hallucination about CE/PE direction
                m.put("favorableUnderlyingDirection",
                        "CE".equals(curOptType) ? "UP" : "PE".equals(curOptType) ? "DOWN" : null);
                m.put("currentTradeDirectionExplanation",
                        "CE".equals(curOptType) ? "CE (Call) benefits when NIFTY moves UP. UP candles are favorable." :
                        "PE".equals(curOptType) ? "PE (Put) benefits when NIFTY moves DOWN. DOWN candles are favorable." : null);
                // pnlPctVal already declared above — reuse for outcome label
                m.put("tradeOutcome", pnlPctVal > 0 ? "PROFIT" : pnlPctVal < 0 ? "LOSS" : "BREAKEVEN");
            }
            return m;
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
                            .orElse(new OptionsReplayRequest.PenaltyConfig()),
                    Optional.ofNullable(req.getMinMovementFilterConfig())
                            .orElse(new OptionsReplayRequest.MinMovementFilterConfig()),
                    Optional.ofNullable(req.getDirectionalConsistencyFilterConfig())
                            .orElse(new OptionsReplayRequest.DirectionalConsistencyFilterConfig()),
                    Optional.ofNullable(req.getCandleStrengthFilterConfig())
                            .orElse(new OptionsReplayRequest.CandleStrengthFilterConfig()),
                    Optional.ofNullable(req.getNoNewTradesAfterTimeConfig())
                            .orElse(new OptionsReplayRequest.NoNewTradesAfterTimeConfig()),
                    Optional.ofNullable(req.getStopLossCascadeProtectionConfig())
                            .orElse(new OptionsReplayRequest.StopLossCascadeProtectionConfig()),
                    Optional.ofNullable(req.getRealTrendConfig())
                            .orElse(new OptionsReplayRequest.RealTrendConfig()));
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

        private double[] toDoubleArray(List<Double> list) {
            return list.stream().mapToDouble(Double::doubleValue).toArray();
        }

        /** Derives CE or PE from a trading symbol suffix when execEngine doesn't track it. */
        private static String deriveOptionType(String symbol) {
            if (symbol == null) return null;
            if (symbol.endsWith("CE")) return "CE";
            if (symbol.endsWith("PE")) return "PE";
            return null;
        }

        private static LocalDateTime toLDT(long epochMs) {
            return Instant.ofEpochMilli(epochMs).atZone(IST).toLocalDateTime();
        }
    }
}
