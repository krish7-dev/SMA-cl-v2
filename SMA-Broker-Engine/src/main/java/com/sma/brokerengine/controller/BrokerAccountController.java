package com.sma.brokerengine.controller;

import com.sma.brokerengine.model.response.ApiResponse;
import com.sma.brokerengine.model.response.BrokerAuthResponse;
import com.sma.brokerengine.service.BrokerAuthService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/broker/accounts")
@RequiredArgsConstructor
public class BrokerAccountController {

    private final BrokerAuthService brokerAuthService;

    /**
     * Lists all persisted broker accounts. Sensitive fields (tokens, secrets) are never returned.
     * Optionally filter by userId.
     *
     * GET /api/v1/broker/accounts
     * GET /api/v1/broker/accounts?userId=user123
     */
    @GetMapping
    public ResponseEntity<ApiResponse<List<BrokerAuthResponse>>> listAccounts(
            @RequestParam(required = false) String userId) {
        List<BrokerAuthResponse> accounts = brokerAuthService.listAccounts(userId);
        return ResponseEntity.ok(ApiResponse.ok(accounts));
    }
}
