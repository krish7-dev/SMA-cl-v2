package com.sma.brokerengine.model.request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class CancelOrderRequest {

    @NotBlank
    private String userId;

    @NotBlank
    private String brokerName;

    @NotBlank
    private String clientOrderId;
}
