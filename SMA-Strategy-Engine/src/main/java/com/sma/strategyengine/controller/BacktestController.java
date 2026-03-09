package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.model.response.BacktestResult;
import com.sma.strategyengine.service.BacktestService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Backtest endpoint.
 *
 * POST /api/v1/strategy/backtest
 *
 * Accepts one or more strategy configurations and a date range, fetches
 * historical candles from Data Engine, replays them through each strategy,
 * and returns a side-by-side metrics comparison.
 */
@RestController
@RequestMapping("/api/v1/strategy")
@RequiredArgsConstructor
public class BacktestController {

    private final BacktestService backtestService;

    @PostMapping("/backtest")
    public ResponseEntity<ApiResponse<BacktestResult>> backtest(
            @Valid @RequestBody BacktestRequest request) {
        BacktestResult result = backtestService.run(request);
        String msg = "Backtest complete — " + result.getTotalCandles() + " candles, "
                + result.getResults().size() + " strategy run(s). Best: " + result.getBestStrategyLabel();
        return ResponseEntity.ok(ApiResponse.ok(result, msg));
    }
}
