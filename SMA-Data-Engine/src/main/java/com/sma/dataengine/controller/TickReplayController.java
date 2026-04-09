package com.sma.dataengine.controller;

import com.sma.dataengine.model.request.TickQueryRequest;
import com.sma.dataengine.model.response.ApiResponse;
import com.sma.dataengine.model.response.TickEntryDto;
import com.sma.dataengine.model.response.TickSessionInfo;
import com.sma.dataengine.service.TickQueryService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Endpoints for the Tick Replay Test feature.
 *
 * GET  /api/v1/data/ticks/sessions  — list all recorded sessions with metadata
 * POST /api/v1/data/ticks/query     — fetch raw ticks for a session + token set
 */
@RestController
@RequestMapping("/api/v1/data/ticks")
@RequiredArgsConstructor
public class TickReplayController {

    private final TickQueryService tickQueryService;

    /**
     * Lists all tick sessions stored in tick_data, newest first.
     * Each entry includes sessionId, first/last tick time, tick count, and token list.
     */
    @GetMapping("/sessions")
    public ResponseEntity<ApiResponse<List<TickSessionInfo>>> sessions() {
        List<TickSessionInfo> sessions = tickQueryService.listSessions();
        return ResponseEntity.ok(ApiResponse.ok(sessions,
                "Found " + sessions.size() + " tick session(s)"));
    }

    /**
     * Fetches raw ticks for the given session and token list, sorted by tick_time.
     * Each entry contains instrumentToken, ltp, volume, and tickTimeMs (epoch ms).
     */
    @PostMapping("/query")
    public ResponseEntity<ApiResponse<List<TickEntryDto>>> query(
            @Valid @RequestBody TickQueryRequest req) {
        List<TickEntryDto> ticks = tickQueryService.queryTicks(req);
        return ResponseEntity.ok(ApiResponse.ok(ticks,
                "Fetched " + ticks.size() + " tick(s)"));
    }
}
