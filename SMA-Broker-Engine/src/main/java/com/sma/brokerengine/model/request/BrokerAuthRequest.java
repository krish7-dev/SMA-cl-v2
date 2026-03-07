package com.sma.brokerengine.model.request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class BrokerAuthRequest {

    @NotBlank
    private String userId;

    @NotBlank
    private String brokerName;

    @NotBlank
    private String clientId;

    @NotBlank
    private String apiKey;

    @NotBlank
    private String apiSecret;

    /**
     * Request token from the broker's OAuth redirect — required for Kite login.
     */
    @NotBlank
    private String requestToken;
}
