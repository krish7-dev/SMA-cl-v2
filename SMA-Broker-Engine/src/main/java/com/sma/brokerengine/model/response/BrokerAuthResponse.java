package com.sma.brokerengine.model.response;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;

@Data
@Builder
public class BrokerAuthResponse {

    private Long accountId;
    private String userId;
    private String brokerName;
    private String clientId;
    private String status;
    private Instant tokenExpiry;
    private String message;

    /**
     * Returned only on successful login and credential-fetch — null in list/status responses.
     * Allows the UI to save a session without re-entering credentials.
     */
    private String apiKey;
    private String apiSecret;
    private String accessToken;
}
