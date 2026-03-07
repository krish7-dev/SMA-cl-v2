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
}
