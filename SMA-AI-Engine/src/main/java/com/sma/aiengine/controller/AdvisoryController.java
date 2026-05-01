package com.sma.aiengine.controller;

import com.sma.aiengine.model.request.TradeCandidateRequest;
import com.sma.aiengine.model.response.AdvisoryResponse;
import com.sma.aiengine.model.response.ApiResponse;
import com.sma.aiengine.service.AdvisoryService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/ai/advisory")
@RequiredArgsConstructor
public class AdvisoryController {

    private final AdvisoryService advisoryService;

    /**
     * Submit a trade candidate snapshot and receive AI advisory.
     * POST /api/v1/ai/advisory
     * Optional header: X-Request-Id for log correlation.
     */
    @PostMapping
    public ResponseEntity<ApiResponse<AdvisoryResponse>> advise(
            @Valid @RequestBody TradeCandidateRequest request,
            @RequestHeader(value = "X-Request-Id", required = false) String requestId) {
        AdvisoryResponse response = advisoryService.advise(request, requestId);
        return ResponseEntity.ok(ApiResponse.ok(response, "Advisory generated"));
    }

    /**
     * Get advisory by DB id.
     * GET /api/v1/ai/advisory/{id}
     */
    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<AdvisoryResponse>> getById(@PathVariable Long id) {
        AdvisoryResponse response = advisoryService.getById(id);
        return ResponseEntity.ok(ApiResponse.ok(response));
    }

    /**
     * List advisories with optional filters.
     * GET /api/v1/ai/advisory?sessionId=&symbol=
     */
    @GetMapping
    public ResponseEntity<ApiResponse<List<AdvisoryResponse>>> list(
            @RequestParam(required = false) String sessionId,
            @RequestParam(required = false) String symbol) {
        List<AdvisoryResponse> responses = advisoryService.list(sessionId, symbol);
        return ResponseEntity.ok(ApiResponse.ok(responses));
    }
}
