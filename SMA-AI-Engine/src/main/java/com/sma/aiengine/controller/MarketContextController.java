package com.sma.aiengine.controller;

import com.sma.aiengine.model.request.MarketContextRequest;
import com.sma.aiengine.model.response.ApiResponse;
import com.sma.aiengine.model.response.MarketContextResponse;
import com.sma.aiengine.service.MarketContextService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/ai/market-context")
@RequiredArgsConstructor
public class MarketContextController {

    private final MarketContextService marketContextService;

    /**
     * Evaluate market tradability for the current NIFTY candle.
     * POST /api/v1/ai/market-context
     */
    @PostMapping
    public ResponseEntity<ApiResponse<MarketContextResponse>> evaluate(
            @Valid @RequestBody MarketContextRequest request,
            @RequestHeader(value = "X-Request-Id", required = false) String requestId) {
        ApiResponse<MarketContextResponse> response = marketContextService.evaluate(request, requestId);
        return ResponseEntity.ok(response);
    }

    /**
     * List all market context evaluations for a session, newest first.
     * GET /api/v1/ai/market-context?sessionId=
     */
    @GetMapping
    public ResponseEntity<ApiResponse<List<MarketContextResponse>>> list(
            @RequestParam String sessionId) {
        List<MarketContextResponse> responses = marketContextService.listBySession(sessionId);
        return ResponseEntity.ok(ApiResponse.ok(responses));
    }
}
