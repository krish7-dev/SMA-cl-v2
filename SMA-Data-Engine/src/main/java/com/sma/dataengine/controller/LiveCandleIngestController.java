package com.sma.dataengine.controller;

import com.sma.dataengine.model.request.LiveCandleIngestRequest;
import com.sma.dataengine.model.response.ApiResponse;
import com.sma.dataengine.service.LiveCandleIngestService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Receives batched live-recorded candles from Strategy Engine live sessions.
 *
 * POST /api/v1/data/candles/ingest
 *
 * Candles are stored with sourceType=LIVE_RECORDED alongside any existing
 * HISTORICAL_API candles. They can be queried later for replay.
 */
@RestController
@RequestMapping("/api/v1/data/candles")
@RequiredArgsConstructor
public class LiveCandleIngestController {

    private final LiveCandleIngestService liveCandleIngestService;

    @PostMapping("/ingest")
    public ResponseEntity<ApiResponse<Map<String, Integer>>> ingest(
            @Valid @RequestBody LiveCandleIngestRequest request) {
        int persisted = liveCandleIngestService.ingest(request);
        return ResponseEntity.ok(ApiResponse.ok(
                Map.of("persisted", persisted),
                "Ingested " + persisted + " live candles"));
    }
}
