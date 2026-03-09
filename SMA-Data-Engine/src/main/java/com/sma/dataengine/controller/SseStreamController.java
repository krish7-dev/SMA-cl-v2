package com.sma.dataengine.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.dataengine.event.CandleDataEvent;
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
    private final List<SseEmitter> tickClients = new CopyOnWriteArrayList<>();

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
     * Opens an SSE stream for live market tick events.
     * All ticks arriving from any active live subscription are forwarded here.
     */
    @GetMapping(value = "/ticks", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter ticks() {
        SseEmitter emitter = new SseEmitter(600_000L);
        tickClients.add(emitter);
        emitter.onCompletion(() -> tickClients.remove(emitter));
        emitter.onTimeout(() -> { emitter.complete(); tickClients.remove(emitter); });
        emitter.onError(e -> tickClients.remove(emitter));
        log.debug("Tick SSE client connected (total={})", tickClients.size());
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

    /** Receives TickDataEvents from LiveMarketDataService and broadcasts to SSE clients. */
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

        broadcastTicks(payload);
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

    private void broadcastTicks(Map<String, Object> payload) {
        List<SseEmitter> dead = new ArrayList<>();
        for (SseEmitter emitter : tickClients) {
            try {
                String json = objectMapper.writeValueAsString(payload);
                emitter.send(SseEmitter.event().name("tick").data(json));
            } catch (Exception e) {
                dead.add(emitter);
            }
        }
        tickClients.removeAll(dead);
    }

    // ─── Inner Record ─────────────────────────────────────────────────────────

    /** Associates an SSE emitter with an optional replay session filter. */
    private record SseEntry(SseEmitter emitter, String sessionId) {}
}
