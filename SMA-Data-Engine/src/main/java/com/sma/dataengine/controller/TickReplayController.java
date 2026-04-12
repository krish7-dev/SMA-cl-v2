package com.sma.dataengine.controller;

import com.sma.dataengine.model.request.TickQueryRequest;
import com.sma.dataengine.model.response.ApiResponse;
import com.sma.dataengine.model.response.TickEntryDto;
import com.sma.dataengine.model.response.TickPageResponse;
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
     *
     * <p><b>Replay engine path</b> — do NOT add a row cap here. The replay engine
     * (TickOptionsReplayService via DataEngineClient) calls this endpoint and requires
     * the complete tick sequence. Any cap here would silently reduce replay fidelity.
     */
    @PostMapping("/query")
    public ResponseEntity<ApiResponse<List<TickEntryDto>>> query(
            @Valid @RequestBody TickQueryRequest req) {
        List<TickEntryDto> ticks = tickQueryService.queryTicks(req);
        return ResponseEntity.ok(ApiResponse.ok(ticks,
                "Fetched " + ticks.size() + " tick(s)"));
    }

    /**
     * Capped tick query for the compare / debug UI.
     *
     * <p>Returns at most 50,000 rows with truncation metadata. Date filtering is applied
     * in the DB query (not post-fetch). The existing {@code /query} endpoint is unchanged
     * so the replay engine is never affected by this cap.
     *
     * <p>Response shape: {@code ApiResponse<TickPageResponse>} where TickPageResponse contains:
     * <ul>
     *   <li>{@code ticks}         — list of tick entries, ordered by tick_time ASC</li>
     *   <li>{@code truncated}     — true if the session has more ticks than the cap</li>
     *   <li>{@code returnedCount} — number of rows actually returned</li>
     *   <li>{@code totalCount}    — total matching rows in the DB (from COUNT query)</li>
     * </ul>
     */
    @PostMapping("/query/compare")
    public ResponseEntity<ApiResponse<TickPageResponse>> queryForCompare(
            @Valid @RequestBody TickQueryRequest req) {
        TickPageResponse result = tickQueryService.queryTicksCapped(req);
        String msg = result.isTruncated()
                ? String.format("Returned %,d of %,d tick(s) — truncated at cap",
                        result.getReturnedCount(), result.getTotalCount())
                : String.format("Fetched %,d tick(s)", result.getReturnedCount());
        return ResponseEntity.ok(ApiResponse.ok(result, msg));
    }
}
