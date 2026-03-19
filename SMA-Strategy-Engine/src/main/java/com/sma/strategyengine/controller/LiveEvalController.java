package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.LiveEvalRequest;
import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.model.snapshot.LiveSessionSnapshot;
import com.sma.strategyengine.service.LiveEvalService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;

/**
 * REST + SSE endpoints for live strategy evaluation.
 *
 * <pre>
 * POST   /api/v1/strategy/live/evaluate          — start a session, returns sessionId
 * GET    /api/v1/strategy/live/stream/{sessionId} — SSE stream of candle events
 * DELETE /api/v1/strategy/live/{sessionId}        — stop a session
 * </pre>
 *
 * <p>Usage flow:
 * <ol>
 *   <li>Client calls {@code POST /evaluate} with a {@link LiveEvalRequest} payload.</li>
 *   <li>Server returns {@code 200 OK} with {@code {"sessionId": "..."}}</li>
 *   <li>Client opens an SSE connection to {@code GET /stream/{sessionId}}.</li>
 *   <li>Server streams {@code candle} SSE events (JSON envelope with instrumentToken, symbol, candle).</li>
 *   <li>Client calls {@code DELETE /{sessionId}} to stop the session when done.</li>
 * </ol>
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/strategy/live")
@RequiredArgsConstructor
public class LiveEvalController {

    private final LiveEvalService liveEvalService;

    /**
     * Starts a live evaluation session.
     *
     * <p>Creates an SseEmitter and registers it with the service before returning
     * the sessionId. The client must then connect to the stream endpoint within
     * a reasonable time (the emitter has Long.MAX_VALUE timeout).
     */
    @PostMapping("/evaluate")
    public ResponseEntity<ApiResponse<Map<String, String>>> start(
            @Valid @RequestBody LiveEvalRequest req) {

        log.info("Live eval start request: {} instrument(s), interval={}, {} strategy config(s)",
                req.getInstruments() != null ? req.getInstruments().size() : 0,
                req.getCandleInterval(),
                req.getStrategies() != null ? req.getStrategies().size() : 0);

        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);
        String sessionId = liveEvalService.start(req, emitter);

        return ResponseEntity.ok(ApiResponse.ok(Map.of("sessionId", sessionId)));
    }

    /**
     * Opens the SSE stream for a live evaluation session.
     *
     * <p>Events are named {@code candle} and carry a JSON object:
     * <pre>{
     *   "instrumentToken": 12345,
     *   "symbol": "NIFTY",
     *   "candle": { ... ReplayCandleEvent ... }
     * }</pre>
     *
     * <p>An {@code init} event is emitted first with session metadata.
     * An {@code info} event is emitted after each instrument's preload completes.
     *
     * @param sessionId the sessionId returned by {@code POST /evaluate}
     * @return SSE emitter; 404 if sessionId is not found
     */
    @GetMapping(value = "/stream/{sessionId}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@PathVariable String sessionId) {
        SseEmitter emitter = liveEvalService.getEmitter(sessionId);
        if (emitter == null) {
            // Return a completed emitter with an error event so the client gets a graceful response
            SseEmitter dead = new SseEmitter(0L);
            try {
                dead.send(SseEmitter.event().name("error").data("Session not found: " + sessionId));
                dead.complete();
            } catch (Exception ignored) {}
            return dead;
        }
        return emitter;
    }

    /**
     * Stops a live evaluation session and releases its resources.
     */
    @DeleteMapping("/{sessionId}")
    public ResponseEntity<ApiResponse<Void>> stop(@PathVariable String sessionId) {
        liveEvalService.stop(sessionId);
        return ResponseEntity.ok(ApiResponse.ok(null, "Session stopped"));
    }

    /**
     * Returns the last saved snapshot for a (userId, brokerName) pair, if one exists.
     * The frontend can call this on mount to detect a resumable session.
     */
    @GetMapping("/snapshot")
    public ResponseEntity<ApiResponse<LiveSessionSnapshot>> getSnapshot(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        return liveEvalService.getSnapshot(userId, brokerName)
                .map(snap -> ResponseEntity.ok(ApiResponse.ok(snap, "Snapshot found")))
                .orElse(ResponseEntity.ok(ApiResponse.ok(null, "No snapshot")));
    }

    /**
     * Deletes the saved snapshot for a (userId, brokerName) pair.
     * The frontend calls this when the user explicitly discards a previous session.
     */
    @DeleteMapping("/snapshot")
    public ResponseEntity<ApiResponse<Void>> deleteSnapshot(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        liveEvalService.deleteSnapshot(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(null, "Snapshot deleted"));
    }
}
