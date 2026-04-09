package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.TickOptionsReplayRequest;
import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.service.options.TickOptionsReplayService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

/**
 * REST + SSE endpoints for tick-based options replay.
 *
 * <pre>
 * POST   /api/v1/strategy/tick-replay/evaluate              — start background session, returns sessionId
 * GET    /api/v1/strategy/tick-replay/stream/{sessionId}    — attach SSE listener (UI only)
 * GET    /api/v1/strategy/tick-replay/sessions              — list all active sessions
 * DELETE /api/v1/strategy/tick-replay/{sessionId}           — stop session entirely
 * </pre>
 *
 * <p>Same lifecycle as OptionsLiveController:
 * <ul>
 *   <li>POST /evaluate starts the background session and returns immediately.</li>
 *   <li>GET /stream attaches a monitoring SSE connection; the session keeps running when it closes.</li>
 *   <li>Session auto-terminates when the tick stream is exhausted.</li>
 *   <li>Only DELETE stops the session early.</li>
 * </ul>
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/strategy/tick-replay")
@RequiredArgsConstructor
public class TickOptionsReplayController {

    private final TickOptionsReplayService tickOptionsReplayService;

    /**
     * Starts a tick replay background session.
     * Returns immediately with a sessionId — the session runs independently of this HTTP connection.
     */
    @PostMapping("/evaluate")
    public ResponseEntity<ApiResponse<Map<String, String>>> start(
            @RequestBody TickOptionsReplayRequest req) {

        log.info("Tick replay start: tickSession={} interval={} NIFTY={} CE={} PE={}",
                req.getSessionId(), req.getInterval(), req.getNiftyInstrumentToken(),
                req.getCeOptions() != null ? req.getCeOptions().size() : 0,
                req.getPeOptions() != null ? req.getPeOptions().size() : 0);

        String sessionId = tickOptionsReplayService.start(req);
        return ResponseEntity.ok(ApiResponse.ok(Map.of("sessionId", sessionId)));
    }

    /**
     * Attaches a UI SSE listener to a running session.
     * Replays buffered events so the UI sees current state on connect.
     * Closing this stream does NOT stop the session — only DELETE does.
     */
    @GetMapping(value = "/stream/{sessionId}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@PathVariable String sessionId) {
        SseEmitter emitter = tickOptionsReplayService.attach(sessionId);
        if (emitter == null) {
            SseEmitter dead = new SseEmitter(0L);
            try {
                dead.send(SseEmitter.event().name("error")
                        .data("Tick replay session not found: " + sessionId));
                dead.complete();
            } catch (Exception ignored) {}
            return dead;
        }
        return emitter;
    }

    /**
     * Lists all currently active (still-running) replay sessions.
     */
    @GetMapping("/sessions")
    public ResponseEntity<ApiResponse<List<Map<String, String>>>> listSessions() {
        return ResponseEntity.ok(ApiResponse.ok(tickOptionsReplayService.listSessions()));
    }

    /**
     * Stops a replay session early. The session also stops automatically when all ticks are exhausted.
     */
    @DeleteMapping("/{sessionId}")
    public ResponseEntity<ApiResponse<Void>> stop(@PathVariable String sessionId) {
        tickOptionsReplayService.stop(sessionId);
        return ResponseEntity.ok(ApiResponse.ok(null, "Session stopped"));
    }
}
