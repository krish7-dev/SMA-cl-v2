package com.sma.dataengine.controller;

import com.sma.dataengine.model.request.ConnectRequest;
import com.sma.dataengine.model.request.SubscriptionRequest;
import com.sma.dataengine.model.request.UnsubscribeRequest;
import com.sma.dataengine.model.response.ApiResponse;
import com.sma.dataengine.model.response.SubscriptionResponse;
import com.sma.dataengine.service.LiveMarketDataService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Live market data subscription management.
 *
 * POST /api/v1/data/live/subscribe    — open or extend a live WebSocket subscription
 * POST /api/v1/data/live/unsubscribe  — remove instruments from an active subscription
 * DELETE /api/v1/data/live/disconnect — tear down the WebSocket session entirely
 */
@RestController
@RequestMapping("/api/v1/data/live")
@RequiredArgsConstructor
public class MarketDataController {

    private final LiveMarketDataService liveMarketDataService;

    /**
     * Establishes the KiteTicker WebSocket connection without subscribing any instruments.
     * Call this first, then poll GET /status until connected=true, then call /subscribe.
     *
     * POST /api/v1/data/live/connect
     */
    @PostMapping("/connect")
    public ResponseEntity<ApiResponse<Void>> connect(
            @Valid @RequestBody ConnectRequest request) {
        liveMarketDataService.connect(
                request.getUserId(), request.getBrokerName(),
                request.getApiKey(), request.getAccessToken());
        return ResponseEntity.ok(ApiResponse.ok(null, "KiteTicker connecting"));
    }

    /**
     * Opens a live WebSocket subscription for the given instruments.
     * If a session already exists for (userId, brokerName), instruments are added to it.
     *
     * POST /api/v1/data/live/subscribe
     */
    @PostMapping("/subscribe")
    public ResponseEntity<ApiResponse<SubscriptionResponse>> subscribe(
            @Valid @RequestBody SubscriptionRequest request) {
        SubscriptionResponse response = liveMarketDataService.subscribe(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Subscription active"));
    }

    /**
     * Removes instruments from an active subscription without closing the connection.
     *
     * POST /api/v1/data/live/unsubscribe
     */
    @PostMapping("/unsubscribe")
    public ResponseEntity<ApiResponse<SubscriptionResponse>> unsubscribe(
            @Valid @RequestBody UnsubscribeRequest request) {
        SubscriptionResponse response = liveMarketDataService.unsubscribe(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Unsubscribed"));
    }

    /**
     * Disconnects the WebSocket session for (userId, brokerName) entirely.
     *
     * DELETE /api/v1/data/live/disconnect?userId=&brokerName=
     */
    @DeleteMapping("/disconnect")
    public ResponseEntity<ApiResponse<Void>> disconnect(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        liveMarketDataService.disconnect(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(null, "Session disconnected"));
    }

    /**
     * Returns whether a live session is currently connected.
     *
     * GET /api/v1/data/live/status?userId=&brokerName=
     */
    @GetMapping("/status")
    public ResponseEntity<ApiResponse<Boolean>> status(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        boolean connected = liveMarketDataService.isConnected(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(connected,
                connected ? "Session is connected" : "No active session"));
    }
}
