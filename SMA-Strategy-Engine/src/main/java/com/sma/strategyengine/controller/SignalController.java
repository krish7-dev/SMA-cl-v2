package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.model.response.SignalResponse;
import com.sma.strategyengine.service.SignalService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Signal history queries.
 *
 * GET /api/v1/strategy/signals?instanceId=                   — all signals for an instance
 * GET /api/v1/strategy/signals?instanceId=&actionableOnly=true — BUY/SELL only
 * GET /api/v1/strategy/signals?symbol=&exchange=             — all signals for an instrument
 */
@RestController
@RequestMapping("/api/v1/strategy/signals")
@RequiredArgsConstructor
public class SignalController {

    private final SignalService signalService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<SignalResponse>>> getSignals(
            @RequestParam(required = false) String instanceId,
            @RequestParam(required = false) String symbol,
            @RequestParam(required = false) String exchange,
            @RequestParam(defaultValue = "false") boolean actionableOnly) {

        List<SignalResponse> results;

        if (instanceId != null && !instanceId.isBlank()) {
            results = actionableOnly
                    ? signalService.getActionableByInstance(instanceId)
                    : signalService.getByInstance(instanceId);
        } else if (symbol != null && exchange != null) {
            results = signalService.getBySymbol(symbol, exchange);
        } else {
            throw new IllegalArgumentException("Provide either instanceId or both symbol and exchange");
        }

        return ResponseEntity.ok(ApiResponse.ok(results));
    }
}
