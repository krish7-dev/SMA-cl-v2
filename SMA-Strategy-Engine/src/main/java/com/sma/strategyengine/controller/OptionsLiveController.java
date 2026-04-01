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

import java.util.Map;

/**
 * REST + SSE endpoints for live NIFTY-driven options evaluation.
 *
 * <pre>
 * POST   /api/v1/strategy/options-live/evaluate          — start session, returns sessionId
 * GET    /api/v1/strategy/options-live/stream/{sessionId} — SSE stream of candle events
 * DELETE /api/v1/strategy/options-live/{sessionId}        — stop session
 * </pre>
 *
 * <p>Usage flow:
 * <ol>
 *   <li>POST /evaluate with {@link OptionsLiveRequest} → {@code {"data": {"sessionId": "..."}}}.</li>
 *   <li>Open SSE connection to GET /stream/{sessionId}.</li>
 *   <li>Server emits {@code init} once, then {@code candle} events ({@code OptionsReplayCandleEvent}).</li>
 *   <li>DELETE /{sessionId} to stop the session.</li>
 * </ol>
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/strategy/options-live")
@RequiredArgsConstructor
public class OptionsLiveController {

    private final OptionsLiveService optionsLiveService;

    /**
     * Starts a live options evaluation session.
     * Returns a sessionId; client must then connect to the stream endpoint.
     */
    @PostMapping("/evaluate")
    public ResponseEntity<ApiResponse<Map<String, String>>> start(
            @RequestBody OptionsLiveRequest req) {

        log.info("Options live evaluate: interval={}, strategies={}, CE={}, PE={}",
                req.getInterval(),
                req.getStrategies() != null ? req.getStrategies().size() : 0,
                req.getCeOptions()  != null ? req.getCeOptions().size()  : 0,
                req.getPeOptions()  != null ? req.getPeOptions().size()  : 0);

        SseEmitter emitter   = new SseEmitter(Long.MAX_VALUE);
        String     sessionId = optionsLiveService.start(req, emitter);

        return ResponseEntity.ok(ApiResponse.ok(Map.of("sessionId", sessionId)));
    }

    /**
     * SSE stream for a live options session.
     *
     * <p>Events:
     * <ul>
     *   <li>{@code init}   — session metadata (sessionId, warmupCandles, ceOptions, peOptions).</li>
     *   <li>{@code candle} — {@code OptionsReplayCandleEvent} JSON on each NIFTY candle close.</li>
     *   <li>{@code error}  — if the session terminates unexpectedly.</li>
     * </ul>
     */
    @GetMapping(value = "/stream/{sessionId}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@PathVariable String sessionId) {
        SseEmitter emitter = optionsLiveService.getEmitter(sessionId);
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
     * Stops a live options evaluation session.
     */
    @DeleteMapping("/{sessionId}")
    public ResponseEntity<ApiResponse<Void>> stop(@PathVariable String sessionId) {
        optionsLiveService.stop(sessionId);
        return ResponseEntity.ok(ApiResponse.ok(null, "Session stopped"));
    }
}
