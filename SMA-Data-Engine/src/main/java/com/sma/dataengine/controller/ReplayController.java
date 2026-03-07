package com.sma.dataengine.controller;

import com.sma.dataengine.model.request.ReplayRequest;
import com.sma.dataengine.model.response.ApiResponse;
import com.sma.dataengine.model.response.ReplayResponse;
import com.sma.dataengine.service.ReplayService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Historical data replay session management.
 *
 * POST   /api/v1/data/replay/start        — start a new replay session
 * POST   /api/v1/data/replay/stop/{id}    — stop an in-progress session
 * GET    /api/v1/data/replay/status/{id}  — check session status
 */
@RestController
@RequestMapping("/api/v1/data/replay")
@RequiredArgsConstructor
public class ReplayController {

    private final ReplayService replayService;

    /**
     * Starts a replay session for the given instrument + interval + time range.
     * Candles must already be persisted in the DB (call POST /api/v1/data/history first).
     * Emits CandleDataEvents at the requested speed.
     *
     * POST /api/v1/data/replay/start
     */
    @PostMapping("/start")
    public ResponseEntity<ApiResponse<ReplayResponse>> start(
            @Valid @RequestBody ReplayRequest request) {
        ReplayResponse response = replayService.start(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Replay session started"));
    }

    /**
     * Stops a running replay session. Safe to call on already-stopped sessions.
     *
     * POST /api/v1/data/replay/stop/{sessionId}
     */
    @PostMapping("/stop/{sessionId}")
    public ResponseEntity<ApiResponse<ReplayResponse>> stop(
            @PathVariable String sessionId) {
        ReplayResponse response = replayService.stop(sessionId);
        return ResponseEntity.ok(ApiResponse.ok(response, "Replay session stopped"));
    }

    /**
     * Returns the current status of a replay session (PENDING, RUNNING, COMPLETED, STOPPED, FAILED).
     *
     * GET /api/v1/data/replay/status/{sessionId}
     */
    @GetMapping("/status/{sessionId}")
    public ResponseEntity<ApiResponse<ReplayResponse>> status(
            @PathVariable String sessionId) {
        ReplayResponse response = replayService.getStatus(sessionId);
        return ResponseEntity.ok(ApiResponse.ok(response));
    }
}
