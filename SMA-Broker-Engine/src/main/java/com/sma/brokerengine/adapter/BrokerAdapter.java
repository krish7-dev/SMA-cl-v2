package com.sma.brokerengine.adapter;

import com.sma.brokerengine.model.response.MarginResponse;
import com.sma.brokerengine.model.response.PositionResponse;

import java.util.List;
import java.util.Map;

/**
 * Abstraction over broker-specific SDKs and APIs.
 *
 * Each broker (Kite, AngelOne, Fyers, etc.) provides its own implementation.
 * No broker SDK types must be exposed beyond this interface boundary — all
 * method signatures use only platform-internal types.
 */
public interface BrokerAdapter {

    /**
     * Returns the canonical broker name this adapter handles.
     */
    String getBrokerName();

    /**
     * Exchanges a request token for an access token with the broker.
     *
     * @param apiKey       broker API key (plaintext — decrypted before call)
     * @param apiSecret    broker API secret (plaintext — decrypted before call)
     * @param requestToken short-lived token from broker OAuth redirect
     * @return the access token to be stored (encrypted) in the database
     */
    String generateAccessToken(String apiKey, String apiSecret, String requestToken);

    /**
     * Places an order with the broker and returns the broker-assigned order ID.
     *
     * @param accessToken decrypted access token
     * @param apiKey      decrypted API key
     * @param params      order parameters (symbol, qty, price, type, etc.)
     * @return broker order ID
     */
    String placeOrder(String accessToken, String apiKey, Map<String, Object> params);

    /**
     * Cancels an open order by its broker order ID.
     *
     * @param accessToken  decrypted access token
     * @param apiKey       decrypted API key
     * @param brokerOrderId order ID returned by the broker at placement
     * @param variety      order variety (e.g., "regular", "amo") — broker-specific
     */
    void cancelOrder(String accessToken, String apiKey, String brokerOrderId, String variety);

    /**
     * Fetches the current status of an order from the broker.
     *
     * @return a map of raw order fields from the broker response
     */
    Map<String, Object> getOrderStatus(String accessToken, String apiKey, String brokerOrderId);

    /**
     * Fetches all open positions from the broker for the authenticated account.
     */
    List<PositionResponse> getPositions(String accessToken, String apiKey);

    /**
     * Fetches margin data for all segments from the broker.
     */
    List<MarginResponse> getMargins(String accessToken, String apiKey);
}
