package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.CreateStrategyRequest;
import com.sma.strategyengine.model.request.UpdateStrategyRequest;
import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.model.response.StrategyResponse;
import com.sma.strategyengine.service.StrategyService;
import com.sma.strategyengine.strategy.StrategyRegistry;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Set;

/**
 * Strategy instance lifecycle management.
 *
 * POST   /api/v1/strategy/instances                          — create
 * GET    /api/v1/strategy/instances/{instanceId}             — get one
 * GET    /api/v1/strategy/instances?userId=&status=          — list by user
 * PUT    /api/v1/strategy/instances/{instanceId}             — update config
 * DELETE /api/v1/strategy/instances/{instanceId}             — delete
 * POST   /api/v1/strategy/instances/{instanceId}/activate    — go ACTIVE
 * POST   /api/v1/strategy/instances/{instanceId}/deactivate  — go INACTIVE
 * GET    /api/v1/strategy/types                              — list available strategy types
 */
@RestController
@RequestMapping("/api/v1/strategy")
@RequiredArgsConstructor
public class StrategyController {

    private final StrategyService  strategyService;
    private final StrategyRegistry strategyRegistry;

    @PostMapping("/instances")
    public ResponseEntity<ApiResponse<StrategyResponse>> create(
            @Valid @RequestBody CreateStrategyRequest request) {
        StrategyResponse response = strategyService.create(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Strategy instance created"));
    }

    @GetMapping("/instances/{instanceId}")
    public ResponseEntity<ApiResponse<StrategyResponse>> getById(
            @PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(strategyService.getById(instanceId)));
    }

    @GetMapping("/instances")
    public ResponseEntity<ApiResponse<List<StrategyResponse>>> listByUser(
            @RequestParam String userId,
            @RequestParam(required = false) String status) {
        return ResponseEntity.ok(ApiResponse.ok(strategyService.listByUser(userId, status)));
    }

    @PutMapping("/instances/{instanceId}")
    public ResponseEntity<ApiResponse<StrategyResponse>> update(
            @PathVariable String instanceId,
            @Valid @RequestBody UpdateStrategyRequest request) {
        StrategyResponse response = strategyService.update(instanceId, request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Strategy instance updated"));
    }

    @DeleteMapping("/instances/{instanceId}")
    public ResponseEntity<ApiResponse<Void>> delete(@PathVariable String instanceId) {
        strategyService.delete(instanceId);
        return ResponseEntity.ok(ApiResponse.ok(null, "Strategy instance deleted"));
    }

    @PostMapping("/instances/{instanceId}/activate")
    public ResponseEntity<ApiResponse<StrategyResponse>> activate(@PathVariable String instanceId) {
        StrategyResponse response = strategyService.activate(instanceId);
        return ResponseEntity.ok(ApiResponse.ok(response, "Strategy instance activated"));
    }

    @PostMapping("/instances/{instanceId}/deactivate")
    public ResponseEntity<ApiResponse<StrategyResponse>> deactivate(@PathVariable String instanceId) {
        StrategyResponse response = strategyService.deactivate(instanceId);
        return ResponseEntity.ok(ApiResponse.ok(response, "Strategy instance deactivated"));
    }

    @GetMapping("/types")
    public ResponseEntity<ApiResponse<Set<String>>> availableTypes() {
        return ResponseEntity.ok(ApiResponse.ok(strategyRegistry.availableTypes(), "Available strategy types"));
    }
}
