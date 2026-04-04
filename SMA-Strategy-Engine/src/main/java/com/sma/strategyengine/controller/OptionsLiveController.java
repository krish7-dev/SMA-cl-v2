package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.OptionsLiveRequest;
import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.service.options.OptionsLiveService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

/**
 * REST + SSE endpoints for live NIFTY-driven options evaluation.
 *
 * <pre>
 * POST   /api/v1/strategy/options-live/evaluate              — start background session, returns sessionId
 * GET    /api/v1/strategy/options-live/stream/{sessionId}    — attach SSE listener (UI only)
 * GET    /api/v1/strategy/options-live/sessions              — list all active sessions
 * GET    /api/v1/strategy/options-live/active/{userId}       — get active sessionId for a user
 * DELETE /api/v1/strategy/options-live/{sessionId}           — stop session entirely
 * </pre>
 *
 * <p>The session lifecycle is fully decoupled from SSE connections:
 * <ul>
 *   <li>POST /evaluate starts the background session and returns immediately.</li>
 *   <li>GET /stream attaches a monitoring SSE connection; the session keeps running when it closes.</li>
 *   <li>Only DELETE stops the session.</li>
 * </ul>
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/strategy/options-live")
@RequiredArgsConstructor
public class OptionsLiveController {

    private final OptionsLiveService optionsLiveService;

    /**
     * Starts a live options background session.
     * Returns immediately with a sessionId — the session runs independently of this HTTP connection.
     * One session per (userId, brokerName) — starting a new one stops the previous one.
     */
    @PostMapping("/evaluate")
    public ResponseEntity<ApiResponse<Map<String, String>>> start(
            @RequestBody OptionsLiveRequest req) {

        log.info("Options live start: userId={} broker={} interval={} strategies={} CE={} PE={}",
                req.getUserId(), req.getBrokerName(), req.getInterval(),
                req.getStrategies() != null ? req.getStrategies().size() : 0,
                req.getCeOptions()  != null ? req.getCeOptions().size()  : 0,
                req.getPeOptions()  != null ? req.getPeOptions().size()  : 0);

        String sessionId = optionsLiveService.start(req);
        return ResponseEntity.ok(ApiResponse.ok(Map.of("sessionId", sessionId)));
    }

    /**
     * Attaches a UI SSE listener to a running session.
     * Replays the last N candle events so the UI catches up immediately.
     * Closing this stream does NOT stop the session — only DELETE does.
     */
    @GetMapping(value = "/stream/{sessionId}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@PathVariable String sessionId) {
        SseEmitter emitter = optionsLiveService.attach(sessionId);
        if (emitter == null) {
            SseEmitter dead = new SseEmitter(0L);
            try {
                dead.send(SseEmitter.event().name("error")
                        .data("Options live session not found: " + sessionId));
                dead.complete();
            } catch (Exception ignored) {}
            return dead;
        }
        return emitter;
    }

    /**
     * Lists all currently active sessions.
     */
    @GetMapping("/sessions")
    public ResponseEntity<ApiResponse<List<Map<String, String>>>> listSessions() {
        return ResponseEntity.ok(ApiResponse.ok(optionsLiveService.listSessions()));
    }

    /**
     * Returns the active sessionId for a given userId, or 404 if none running.
     */
    @GetMapping("/active/{userId}")
    public ResponseEntity<ApiResponse<Map<String, String>>> activeSession(
            @PathVariable String userId) {
        String sessionId = optionsLiveService.activeSessionForUser(userId);
        if (sessionId == null) {
            return ResponseEntity.status(404)
                    .body(ApiResponse.error("No active session for user: " + userId));
        }
        return ResponseEntity.ok(ApiResponse.ok(Map.of("sessionId", sessionId)));
    }

    /**
     * Stops a live session entirely. The session will not restart automatically.
     */
    @DeleteMapping("/{sessionId}")
    public ResponseEntity<ApiResponse<Void>> stop(@PathVariable String sessionId) {
        optionsLiveService.stop(sessionId);
        return ResponseEntity.ok(ApiResponse.ok(null, "Session stopped"));
    }
}
