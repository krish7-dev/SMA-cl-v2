package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.EvaluateRequest;
import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.model.response.EvaluationResponse;
import com.sma.strategyengine.service.EvaluationService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Ingests market data candles and drives strategy evaluation.
 *
 * POST /api/v1/strategy/evaluate
 *
 * Called by Data Engine on each completed candle (live or replay),
 * or directly for manual testing via Swagger UI.
 */
@RestController
@RequestMapping("/api/v1/strategy")
@RequiredArgsConstructor
public class EvaluationController {

    private final EvaluationService evaluationService;

    /**
     * Feed one OHLCV candle into the strategy engine.
     *
     * Finds all ACTIVE strategy instances for the given symbol + exchange,
     * evaluates each, generates signals, and forwards BUY/SELL signals to
     * Execution Engine as order intents.
     */
    @PostMapping("/evaluate")
    public ResponseEntity<ApiResponse<EvaluationResponse>> evaluate(
            @Valid @RequestBody EvaluateRequest request) {
        EvaluationResponse response = evaluationService.evaluate(request);
        String msg = response.getEvaluatedInstances() == 0
                ? "No active strategy instances for this instrument"
                : "Evaluated " + response.getEvaluatedInstances() + " instance(s), "
                + response.getActionableSignals() + " actionable signal(s)";
        return ResponseEntity.ok(ApiResponse.ok(response, msg));
    }
}
