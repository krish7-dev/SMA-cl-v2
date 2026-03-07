package com.sma.dataengine.model.request;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import lombok.Data;

import java.util.List;

/**
 * Request to remove specific instruments from a live subscription.
 * If all instruments are removed, the underlying WebSocket connection stays open
 * for potential re-subscription. Call the disconnect endpoint to tear it down.
 */
@Data
public class UnsubscribeRequest {

    @NotBlank
    private String userId;

    @NotBlank
    private String brokerName;

    /** Numeric instrument tokens to unsubscribe. */
    @NotEmpty
    private List<Long> instrumentTokens;
}
