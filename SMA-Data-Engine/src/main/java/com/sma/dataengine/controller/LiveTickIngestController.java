package com.sma.dataengine.controller;

import com.sma.dataengine.model.request.LiveTickIngestRequest;
import com.sma.dataengine.model.response.ApiResponse;
import com.sma.dataengine.service.LiveTickIngestService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Receives batched raw ticks from Strategy Engine live sessions.
 *
 * POST /api/v1/data/ticks/ingest
 */
@RestController
@RequestMapping("/api/v1/data/ticks")
@RequiredArgsConstructor
public class LiveTickIngestController {

    private final LiveTickIngestService liveTickIngestService;

    @PostMapping("/ingest")
    public ResponseEntity<ApiResponse<Map<String, Integer>>> ingest(
            @Valid @RequestBody LiveTickIngestRequest request) {
        int persisted = liveTickIngestService.ingest(request);
        return ResponseEntity.ok(ApiResponse.ok(
                Map.of("persisted", persisted),
                "Ingested " + persisted + " live ticks"));
    }
}
