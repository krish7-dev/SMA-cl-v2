package com.sma.brokerengine.controller;

import com.sma.brokerengine.model.request.BrokerAuthRequest;
import com.sma.brokerengine.model.response.ApiResponse;
import com.sma.brokerengine.model.response.BrokerAuthResponse;
import com.sma.brokerengine.service.BrokerAuthService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/broker/auth")
@RequiredArgsConstructor
public class BrokerAuthController {

    private final BrokerAuthService brokerAuthService;

    /**
     * Exchanges a broker request token for a session token and persists
     * the encrypted credentials. Must be called after the broker's OAuth redirect.
     *
     * POST /api/v1/broker/auth/login
     */
    @PostMapping("/login")
    public ResponseEntity<ApiResponse<BrokerAuthResponse>> login(
            @Valid @RequestBody BrokerAuthRequest request) {
        BrokerAuthResponse response = brokerAuthService.authenticateAndStoreToken(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Authentication successful"));
    }

    /**
     * Invalidates the stored access token and marks the account inactive.
     *
     * POST /api/v1/broker/auth/logout
     */
    @PostMapping("/logout")
    public ResponseEntity<ApiResponse<Void>> logout(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        brokerAuthService.logout(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(null, "Logged out successfully"));
    }
}
