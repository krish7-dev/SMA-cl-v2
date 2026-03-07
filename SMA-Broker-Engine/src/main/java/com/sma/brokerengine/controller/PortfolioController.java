package com.sma.brokerengine.controller;

import com.sma.brokerengine.model.response.ApiResponse;
import com.sma.brokerengine.model.response.MarginResponse;
import com.sma.brokerengine.model.response.PositionResponse;
import com.sma.brokerengine.service.PortfolioService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/broker/portfolio")
@RequiredArgsConstructor
public class PortfolioController {

    private final PortfolioService portfolioService;

    /**
     * Returns all open positions from the broker.
     *
     * GET /api/v1/broker/portfolio/positions?userId=&brokerName=
     */
    @GetMapping("/positions")
    public ResponseEntity<ApiResponse<List<PositionResponse>>> getPositions(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        List<PositionResponse> positions = portfolioService.getPositions(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(positions));
    }

    /**
     * Returns margin data from the broker.
     *
     * GET /api/v1/broker/portfolio/margins?userId=&brokerName=
     */
    @GetMapping("/margins")
    public ResponseEntity<ApiResponse<List<MarginResponse>>> getMargins(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        List<MarginResponse> margins = portfolioService.getMargins(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(margins));
    }
}
