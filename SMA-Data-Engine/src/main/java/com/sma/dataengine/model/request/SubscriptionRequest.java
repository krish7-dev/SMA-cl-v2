package com.sma.dataengine.model.request;

import com.sma.dataengine.model.InstrumentSubscription;
import com.sma.dataengine.model.SubscriptionMode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.util.List;

/**
 * Request to open a live market data WebSocket subscription.
 *
 * The caller is responsible for supplying a valid API key and access token.
 * In this architecture, SMA-Data-Engine does not own broker authentication —
 * tokens are obtained from SMA-Broker-Engine and passed here by the caller.
 */
@Data
public class SubscriptionRequest {

    /** Logical user identifier — used to key the connection session. */
    @NotBlank
    private String userId;

    /** Broker name (e.g. "kite"). Selects the correct MarketDataAdapter. */
    @NotBlank
    private String brokerName;

    /**
     * Broker API key — required to initialize the WebSocket connection.
     * Obtain from the authenticated session in SMA-Broker-Engine.
     */
    @NotBlank
    private String apiKey;

    /**
     * Live access token for the broker session.
     * Must be a valid, non-expired token from SMA-Broker-Engine.
     */
    @NotBlank
    private String accessToken;

    /** List of instruments to subscribe to. */
    @NotEmpty
    @Valid
    private List<InstrumentSubscription> instruments;

    /**
     * Subscription depth mode. Defaults to FULL if not specified.
     * LTP = last price only, QUOTE = market quote, FULL = full depth.
     */
    @NotNull
    private SubscriptionMode mode;
}
