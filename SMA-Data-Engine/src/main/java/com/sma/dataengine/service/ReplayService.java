package com.sma.dataengine.service;

import com.sma.dataengine.entity.ReplaySession;
import com.sma.dataengine.event.CandleDataEvent;
import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.Interval;
import com.sma.dataengine.model.request.HistoricalDataRequest;
import com.sma.dataengine.model.request.ReplayRequest;
import com.sma.dataengine.model.response.ReplayResponse;
import com.sma.dataengine.repository.ReplaySessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.*;

/**
 * Manages historical data replay sessions.
 *
 * Replay flow:
 * 1. Load candles from DB for the requested instrument + interval + time range.
 * 2. Create a ReplaySession entity (PENDING → RUNNING).
 * 3. Schedule candle emission at the requested speed (candles/second).
 * 4. Each emitted candle is published as a {@link CandleDataEvent} on the
 *    ApplicationEventPublisher for downstream consumers.
 * 5. When complete or stopped, update session status accordingly.
 *
 * Candles must already exist in the candle_data table.
 * Call HistoricalDataService first to populate them.
 */
@Slf4j
@Service
public class ReplayService {

    private final HistoricalDataService    historicalDataService;
    private final ReplaySessionRepository  sessionRepository;
    private final ApplicationEventPublisher eventPublisher;

    private final ScheduledExecutorService scheduler;

    /** In-flight sessions: sessionId → ScheduledFuture for cancellation. */
    private final Map<String, ScheduledFuture<?>> activeFutures = new ConcurrentHashMap<>();

    public ReplayService(
            HistoricalDataService historicalDataService,
            ReplaySessionRepository sessionRepository,
            ApplicationEventPublisher eventPublisher,
            @Value("${data.replay.scheduler-pool-size:4}") int poolSize) {
        this.historicalDataService = historicalDataService;
        this.sessionRepository     = sessionRepository;
        this.eventPublisher        = eventPublisher;
        this.scheduler             = Executors.newScheduledThreadPool(poolSize);
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Starts a replay session. Candles are emitted as CandleDataEvents
     * at a rate of {@code request.speedMultiplier} candles per second.
     *
     * @throws IllegalStateException if no candle data exists for the range
     */
    @Transactional
    public ReplayResponse start(ReplayRequest request) {
        // Load candles from DB — replay never hits the broker API
        HistoricalDataRequest histReq = buildHistoricalRequest(request);
        List<CandleData> candles = historicalDataService.loadFromDbForReplay(histReq);

        if (candles.isEmpty()) {
            throw new IllegalStateException(
                    "No candle data found for replay. Fetch historical data first. " +
                    "token=" + request.getInstrumentToken() +
                    ", interval=" + request.getInterval() +
                    ", from=" + request.getFromDate() +
                    ", to=" + request.getToDate());
        }

        String sessionId = UUID.randomUUID().toString();

        // Persist session record
        ReplaySession session = ReplaySession.builder()
                .sessionId(sessionId)
                .instrumentToken(request.getInstrumentToken())
                .symbol(request.getSymbol())
                .exchange(request.getExchange())
                .interval(request.getInterval().getKiteValue())
                .fromTime(request.getFromDate())
                .toTime(request.getToDate())
                .speedMultiplier(request.getSpeedMultiplier())
                .totalCandles(candles.size())
                .emittedCandles(0)
                .requestedBy(request.getUserId())
                .provider(request.getProvider())
                .status(ReplaySession.Status.PENDING)
                .build();

        sessionRepository.save(session);

        // Schedule emission
        scheduleEmission(session, candles);

        log.info("Replay started: sessionId={}, candles={}, speed={}x",
                sessionId, candles.size(), request.getSpeedMultiplier());

        return ReplayResponse.builder()
                .sessionId(sessionId)
                .instrumentToken(request.getInstrumentToken())
                .symbol(request.getSymbol())
                .exchange(request.getExchange())
                .interval(request.getInterval().getKiteValue())
                .fromDate(request.getFromDate())
                .toDate(request.getToDate())
                .speedMultiplier(request.getSpeedMultiplier())
                .totalCandles(candles.size())
                .status("RUNNING")
                .message("Replay started — " + candles.size() + " candles at " + request.getSpeedMultiplier() + "x speed")
                .build();
    }

    /**
     * Stops an in-progress replay session.
     *
     * @throws IllegalArgumentException if the session ID does not exist
     */
    @Transactional
    public ReplayResponse stop(String sessionId) {
        ReplaySession session = sessionRepository.findBySessionId(sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Replay session not found: " + sessionId));

        cancelFuture(sessionId);

        session.setStatus(ReplaySession.Status.STOPPED);
        session.setCompletedAt(Instant.now());
        sessionRepository.save(session);

        log.info("Replay stopped: sessionId={}", sessionId);

        return ReplayResponse.builder()
                .sessionId(sessionId)
                .status("STOPPED")
                .message("Replay session stopped")
                .build();
    }

    /**
     * Returns the persisted state of a replay session.
     */
    @Transactional(readOnly = true)
    public ReplayResponse getStatus(String sessionId) {
        ReplaySession session = sessionRepository.findBySessionId(sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Replay session not found: " + sessionId));

        return toResponse(session);
    }

    // ─── Scheduling ───────────────────────────────────────────────────────────

    private void scheduleEmission(ReplaySession session, List<CandleData> candles) {
        String sessionId = session.getSessionId();

        // Delay between emissions in milliseconds: 1000ms / speedMultiplier
        long delayMs = Math.max(1, 1000L / session.getSpeedMultiplier());

        // Mutable index via array trick (lambda capture)
        int[] index = {0};

        ScheduledFuture<?> future = scheduler.scheduleAtFixedRate(() -> {
            try {
                if (index[0] >= candles.size()) {
                    // All candles emitted — mark complete and cancel
                    completeSession(sessionId);
                    cancelFuture(sessionId);
                    return;
                }

                CandleData candle = candles.get(index[0]++);
                eventPublisher.publishEvent(new CandleDataEvent(this, candle, true, sessionId));

                // Periodically flush emitted count to DB every 100 candles
                if (index[0] % 100 == 0) {
                    updateEmittedCount(sessionId, index[0]);
                }

            } catch (Exception e) {
                log.error("Error during replay emission for session={}: {}", sessionId, e.getMessage(), e);
                failSession(sessionId);
                cancelFuture(sessionId);
            }
        }, 0, delayMs, TimeUnit.MILLISECONDS);

        activeFutures.put(sessionId, future);

        // Transition to RUNNING
        updateStatus(sessionId, ReplaySession.Status.RUNNING, Instant.now());
    }

    private void cancelFuture(String sessionId) {
        ScheduledFuture<?> f = activeFutures.remove(sessionId);
        if (f != null && !f.isDone()) {
            f.cancel(false);
        }
    }

    // ─── DB State Transitions ─────────────────────────────────────────────────

    @Transactional
    protected void completeSession(String sessionId) {
        sessionRepository.findBySessionId(sessionId).ifPresent(s -> {
            s.setStatus(ReplaySession.Status.COMPLETED);
            s.setCompletedAt(Instant.now());
            sessionRepository.save(s);
            log.info("Replay completed: sessionId={}", sessionId);
        });
    }

    @Transactional
    protected void failSession(String sessionId) {
        sessionRepository.findBySessionId(sessionId).ifPresent(s -> {
            s.setStatus(ReplaySession.Status.FAILED);
            s.setCompletedAt(Instant.now());
            sessionRepository.save(s);
        });
    }

    @Transactional
    protected void updateStatus(String sessionId, ReplaySession.Status status, Instant startedAt) {
        sessionRepository.findBySessionId(sessionId).ifPresent(s -> {
            s.setStatus(status);
            if (startedAt != null) s.setStartedAt(startedAt);
            sessionRepository.save(s);
        });
    }

    @Transactional
    protected void updateEmittedCount(String sessionId, int count) {
        sessionRepository.findBySessionId(sessionId).ifPresent(s -> {
            s.setEmittedCandles(count);
            sessionRepository.save(s);
        });
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static HistoricalDataRequest buildHistoricalRequest(ReplayRequest r) {
        HistoricalDataRequest req = new HistoricalDataRequest();
        req.setUserId(r.getUserId());
        req.setBrokerName(r.getProvider());
        req.setApiKey("");          // not needed for DB-only load
        req.setAccessToken("");     // not needed for DB-only load
        req.setInstrumentToken(r.getInstrumentToken());
        req.setSymbol(r.getSymbol());
        req.setExchange(r.getExchange());
        req.setInterval(r.getInterval());
        req.setFromDate(r.getFromDate());
        req.setToDate(r.getToDate());
        req.setPersist(false);      // loading from DB — no re-persist needed
        return req;
    }

    private static ReplayResponse toResponse(ReplaySession s) {
        return ReplayResponse.builder()
                .sessionId(s.getSessionId())
                .instrumentToken(s.getInstrumentToken())
                .symbol(s.getSymbol())
                .exchange(s.getExchange())
                .interval(s.getInterval())
                .fromDate(s.getFromTime())
                .toDate(s.getToTime())
                .speedMultiplier(s.getSpeedMultiplier())
                .totalCandles(s.getTotalCandles() != null ? s.getTotalCandles() : 0)
                .status(s.getStatus().name())
                .build();
    }
}
