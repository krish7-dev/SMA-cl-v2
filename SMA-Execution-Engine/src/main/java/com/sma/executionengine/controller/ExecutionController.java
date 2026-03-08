package com.sma.executionengine.controller;

import com.sma.executionengine.model.request.ExecutionRequest;
import com.sma.executionengine.model.response.ApiResponse;
import com.sma.executionengine.model.response.ExecutionResponse;
import com.sma.executionengine.service.ExecutionService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/execution/orders")
@RequiredArgsConstructor
public class ExecutionController {

    private final ExecutionService executionService;

    /**
     * Submit an order intent for execution.
     * Idempotent: duplicate intentId returns the existing record.
     *
     * POST /api/v1/execution/orders
     */
    @PostMapping
    public ResponseEntity<ApiResponse<ExecutionResponse>> submit(
            @Valid @RequestBody ExecutionRequest request) {
        ExecutionResponse response = executionService.submit(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Order intent processed"));
    }

    /**
     * Cancel a submitted order by intentId.
     *
     * DELETE /api/v1/execution/orders/{intentId}
     */
    @DeleteMapping("/{intentId}")
    public ResponseEntity<ApiResponse<ExecutionResponse>> cancel(
            @PathVariable String intentId) {
        ExecutionResponse response = executionService.cancel(intentId);
        return ResponseEntity.ok(ApiResponse.ok(response, "Cancellation submitted"));
    }

    /**
     * Get current status of an execution by intentId.
     *
     * GET /api/v1/execution/orders/{intentId}
     */
    @GetMapping("/{intentId}")
    public ResponseEntity<ApiResponse<ExecutionResponse>> getByIntentId(
            @PathVariable String intentId) {
        ExecutionResponse response = executionService.getByIntentId(intentId);
        return ResponseEntity.ok(ApiResponse.ok(response));
    }

    /**
     * Sync execution status against Broker Engine (poll for fills, rejections).
     *
     * POST /api/v1/execution/orders/{intentId}/sync
     */
    @PostMapping("/{intentId}/sync")
    public ResponseEntity<ApiResponse<ExecutionResponse>> syncStatus(
            @PathVariable String intentId) {
        ExecutionResponse response = executionService.syncStatus(intentId);
        return ResponseEntity.ok(ApiResponse.ok(response, "Status synced"));
    }

    /**
     * List all execution records for a user, optionally filtered by broker.
     *
     * GET /api/v1/execution/orders?userId=&brokerName=
     */
    @GetMapping
    public ResponseEntity<ApiResponse<List<ExecutionResponse>>> getByUser(
            @RequestParam String userId,
            @RequestParam(required = false) String brokerName) {
        List<ExecutionResponse> responses = executionService.getByUser(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(responses));
    }
}
