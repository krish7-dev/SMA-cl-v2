package com.sma.dataengine.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.dataengine.event.CandleDataEvent;
import com.sma.dataengine.event.ReplayCompleteEvent;
import com.sma.dataengine.event.TickDataEvent;
import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.TickData;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Server-Sent Events (SSE) bridge between internal Spring events and browser clients.
 *
 * Endpoints:
 *   GET /api/v1/data/stream/candles?sessionId=...  — replay candles (CandleDataEvent)
 *   GET /api/v1/data/stream/ticks                   — live market ticks (TickDataEvent)
 *
 * Clients connect via browser EventSource. Each emitted candle / tick is serialised
 * as a JSON string and delivered as a named SSE event ("candle" or "tick").
 *
 * The ?sessionId filter on /candles lets a browser receive candles only for a
 * specific replay session, preventing cross-contamination when multiple sessions run.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/data/stream")
@RequiredArgsConstructor
public class SseStreamController {

    private final ObjectMapper objectMapper;

    /** Connected browser clients waiting for candle events. */
    private final List<SseEntry> candleClients = new CopyOnWriteArrayList<>();

    /** Connected browser clients waiting for tick events. */
    private final List<SseEntry> tickClients = new CopyOnWriteArrayList<>();

    // ─── Browser Connection Endpoints ─────────────────────────────────────────

    /**
     * Opens an SSE stream for replay candle events.
     *
     * @param sessionId optional filter — when provided, only candles from
     *                  that replay session are forwarded to this client.
     */
    @GetMapping(value = "/candles", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter candles(@RequestParam(required = false) String sessionId) {
        SseEmitter emitter = new SseEmitter(600_000L); // 10-minute max lifetime
        SseEntry entry = new SseEntry(emitter, sessionId);
        candleClients.add(entry);
        emitter.onCompletion(() -> candleClients.remove(entry));
        emitter.onTimeout(() -> { emitter.complete(); candleClients.remove(entry); });
        emitter.onError(e -> candleClients.remove(entry));
        log.debug("Candle SSE client connected (sessionId={}, total={})",
                sessionId, candleClients.size());
        return emitter;
    }

    /**
     * Opens an SSE stream for tick events (live or replay).
     *
     * @param sessionId optional filter — when provided, only replay ticks from that
     *                  session are forwarded; live ticks (replay=false) are excluded.
     *                  When omitted, live ticks are forwarded and replay ticks are excluded.
     */
    @GetMapping(value = "/ticks", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter ticks(@RequestParam(required = false) String sessionId) {
        SseEmitter emitter = new SseEmitter(600_000L);
        SseEntry entry = new SseEntry(emitter, sessionId);
        tickClients.add(entry);
        emitter.onCompletion(() -> tickClients.remove(entry));
        emitter.onTimeout(() -> { emitter.complete(); tickClients.remove(entry); });
        emitter.onError(e -> tickClients.remove(entry));
        log.debug("Tick SSE client connected (sessionId={}, total={})", sessionId, tickClients.size());
        return emitter;
    }

    // ─── Internal Event Listeners ─────────────────────────────────────────────

    /** Receives CandleDataEvents from ReplayService and broadcasts to SSE clients. */
    @EventListener
    public void onCandleEvent(CandleDataEvent event) {
        if (candleClients.isEmpty()) return;
        CandleData c = event.getCandle();

        Map<String, Object> payload = new HashMap<>();
        payload.put("symbol",    c.getSymbol() != null    ? c.getSymbol()    : "");
        payload.put("exchange",  c.getExchange() != null  ? c.getExchange()  : "");
        payload.put("open",      c.getOpen()   != null    ? c.getOpen()      : 0);
        payload.put("high",      c.getHigh()   != null    ? c.getHigh()      : 0);
        payload.put("low",       c.getLow()    != null    ? c.getLow()       : 0);
        payload.put("close",     c.getClose()  != null    ? c.getClose()     : 0);
        payload.put("volume",    c.getVolume() != null    ? c.getVolume()    : 0L);
        payload.put("openTime",  c.getOpenTime() != null  ? c.getOpenTime().toString() : null);
        payload.put("sessionId", event.getReplaySessionId() != null ? event.getReplaySessionId() : "");
        payload.put("replay",    event.isReplay());

        broadcastCandles(payload, event.getReplaySessionId());
    }

    /** Receives TickDataEvents from LiveMarketDataService or ReplayService and broadcasts to SSE clients. */
    @EventListener
    public void onTickEvent(TickDataEvent event) {
        if (tickClients.isEmpty()) return;
        TickData t = event.getTick();

        Map<String, Object> payload = new HashMap<>();
        payload.put("instrumentToken", t.getInstrumentToken() != null ? t.getInstrumentToken() : 0L);
        payload.put("symbol",          t.getSymbol()   != null ? t.getSymbol()   : "");
        payload.put("exchange",        t.getExchange() != null ? t.getExchange() : "");
        payload.put("ltp",             t.getLastTradedPrice()   != null ? t.getLastTradedPrice()   : 0);
        payload.put("open",            t.getOpenPrice()         != null ? t.getOpenPrice()         : 0);
        payload.put("high",            t.getHighPrice()         != null ? t.getHighPrice()         : 0);
        payload.put("low",             t.getLowPrice()          != null ? t.getLowPrice()          : 0);
        payload.put("change",          t.getChangePercent()     != null ? t.getChangePercent()     : 0);
        payload.put("timestamp",       t.getTimestamp() != null ? t.getTimestamp().toString() : null);
        payload.put("replay",          t.isReplay());
        payload.put("sessionId",       t.getReplaySessionId() != null ? t.getReplaySessionId() : "");

        broadcastTicks(payload, t.isReplay() ? t.getReplaySessionId() : null);
    }

    /**
     * Sends a "done" SSE event to the candle client subscribed to the completed session.
     * This lets the browser close its EventSource only after all candle events are processed,
     * avoiding the race where the poll-based status check closes the connection too early.
     */
    @EventListener
    public void onReplayComplete(ReplayCompleteEvent event) {
        String sessionId = event.getSessionId();
        List<SseEntry> dead = new ArrayList<>();
        for (SseEntry entry : candleClients) {
            if (!sessionId.equals(entry.sessionId())) continue;
            try {
                entry.emitter().send(SseEmitter.event().name("done").data(sessionId));
            } catch (Exception e) {
                dead.add(entry);
            }
        }
        candleClients.removeAll(dead);
    }

    // ─── Broadcast Helpers ────────────────────────────────────────────────────

    private void broadcastCandles(Map<String, Object> payload, String sourceSessionId) {
        List<SseEntry> dead = new ArrayList<>();
        for (SseEntry entry : candleClients) {
            // Skip clients filtered to a different session
            if (entry.sessionId() != null && !entry.sessionId().equals(sourceSessionId)) continue;
            try {
                String json = objectMapper.writeValueAsString(payload);
                entry.emitter().send(SseEmitter.event().name("candle").data(json));
            } catch (Exception e) {
                dead.add(entry);
            }
        }
        candleClients.removeAll(dead);
    }

    /**
     * Broadcasts a tick payload to connected clients.
     *
     * Filtering rules:
     * - {@code sourceSessionId} non-null → replay tick: only send to clients subscribed to that session
     * - {@code sourceSessionId} null     → live tick:   only send to clients with no session filter
     */
    private void broadcastTicks(Map<String, Object> payload, String sourceSessionId) {
        List<SseEntry> dead = new ArrayList<>();
        for (SseEntry entry : tickClients) {
            boolean isReplayTick = sourceSessionId != null;
            boolean clientWantsReplay = entry.sessionId() != null;

            if (isReplayTick) {
                // Replay tick → only send to the matching replay session client
                if (!sourceSessionId.equals(entry.sessionId())) continue;
            } else {
                // Live tick → only send to clients without a session filter
                if (clientWantsReplay) continue;
            }

            try {
                String json = objectMapper.writeValueAsString(payload);
                entry.emitter().send(SseEmitter.event().name("tick").data(json));
            } catch (Exception e) {
                dead.add(entry);
            }
        }
        tickClients.removeAll(dead);
    }

    // ─── Inner Record ─────────────────────────────────────────────────────────

    /** Associates an SSE emitter with an optional replay session filter. */
    private record SseEntry(SseEmitter emitter, String sessionId) {}
}
