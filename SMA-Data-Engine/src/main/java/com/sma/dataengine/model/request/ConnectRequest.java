package com.sma.dataengine.model.request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

/**
 * Request to establish the KiteTicker WebSocket connection without subscribing instruments.
 * Use {@link SubscriptionRequest} afterwards to subscribe specific tokens.
 */
@Data
public class ConnectRequest {

    @NotBlank
    private String userId;

    @NotBlank
    private String brokerName;

    @NotBlank
    private String apiKey;

    @NotBlank
    private String accessToken;
}
