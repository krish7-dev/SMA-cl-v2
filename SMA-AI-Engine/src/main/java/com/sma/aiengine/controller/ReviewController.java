package com.sma.aiengine.controller;

import com.sma.aiengine.model.request.CompletedTradeRequest;
import com.sma.aiengine.model.response.ApiResponse;
import com.sma.aiengine.model.response.TradeReviewResponse;
import com.sma.aiengine.service.TradeReviewService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/ai/review")
@RequiredArgsConstructor
public class ReviewController {

    private final TradeReviewService tradeReviewService;

    /**
     * Submit a completed trade snapshot and receive AI quality review.
     * POST /api/v1/ai/review
     * Optional header: X-Request-Id for log correlation.
     */
    @PostMapping
    public ResponseEntity<ApiResponse<TradeReviewResponse>> review(
            @Valid @RequestBody CompletedTradeRequest request,
            @RequestHeader(value = "X-Request-Id", required = false) String requestId) {
        TradeReviewResponse response = tradeReviewService.review(request, requestId);
        return ResponseEntity.ok(ApiResponse.ok(response, "Trade review generated"));
    }

    /**
     * Get review by DB id.
     * GET /api/v1/ai/review/{id}
     */
    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<TradeReviewResponse>> getById(@PathVariable Long id) {
        TradeReviewResponse response = tradeReviewService.getById(id);
        return ResponseEntity.ok(ApiResponse.ok(response));
    }

    /**
     * List reviews with optional filters.
     * GET /api/v1/ai/review?sessionId=&symbol=&tradeId=
     */
    @GetMapping
    public ResponseEntity<ApiResponse<List<TradeReviewResponse>>> list(
            @RequestParam(required = false) String sessionId,
            @RequestParam(required = false) String symbol,
            @RequestParam(required = false) String tradeId) {
        List<TradeReviewResponse> responses = tradeReviewService.list(sessionId, symbol, tradeId);
        return ResponseEntity.ok(ApiResponse.ok(responses));
    }
}
