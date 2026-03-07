package com.sma.dataengine.controller;

import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.request.HistoricalDataRequest;
import com.sma.dataengine.model.response.ApiResponse;
import com.sma.dataengine.service.HistoricalDataService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Historical OHLCV candle data retrieval.
 *
 * POST /api/v1/data/history — fetch candles from broker API (with optional DB persist)
 * GET  /api/v1/data/history — placeholder for query-by-params (future)
 */
@RestController
@RequestMapping("/api/v1/data/history")
@RequiredArgsConstructor
public class HistoricalDataController {

    private final HistoricalDataService historicalDataService;

    /**
     * Fetches historical OHLCV candles from the broker adapter.
     *
     * If candles are already cached in the DB for the requested range, they are
     * returned from cache without hitting the broker API (cache-first).
     * Set persist=true (default) to store fetched candles for future replay.
     *
     * POST /api/v1/data/history
     */
    @PostMapping
    public ResponseEntity<ApiResponse<List<CandleData>>> getHistoricalData(
            @Valid @RequestBody HistoricalDataRequest request) {
        List<CandleData> candles = historicalDataService.getHistoricalData(request);
        return ResponseEntity.ok(ApiResponse.ok(candles,
                "Fetched " + candles.size() + " candles"));
    }
}
