package com.sma.executionengine.client;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.math.BigDecimal;

/**
 * HTTP client for calling Broker Engine's order and status endpoints.
 *
 * All broker auth is handled by Broker Engine — this client never deals
 * with API keys, access tokens, or broker SDKs directly.
 */
@Slf4j
@Component
public class BrokerEngineClient {

    private final String      baseUrl;
    private final HttpClient  http;
    private final ObjectMapper mapper;

    public BrokerEngineClient(
            @Value("${execution.broker-engine.base-url:http://localhost:9003}") String baseUrl,
            ObjectMapper mapper) {
        this.baseUrl = baseUrl;
        this.http    = HttpClient.newHttpClient();
        this.mapper  = mapper;
    }

    // ─── DTOs ─────────────────────────────────────────────────────────────────

    /** Mirrors Broker Engine's PlaceOrderRequest (only fields this service controls). */
    public record PlaceOrderPayload(
            String clientOrderId,
            String userId,
            String brokerName,
            String symbol,
            String exchange,
            String transactionType,   // BUY | SELL
            String orderType,         // MARKET | LIMIT | SL | SL_M
            String product,           // CNC | MIS | NRML
            Integer quantity,
            BigDecimal price,
            BigDecimal triggerPrice,
            String validity,
            String tag
    ) {}

    /** Mirrors Broker Engine's CancelOrderRequest. */
    public record CancelOrderPayload(
            String clientOrderId,
            String userId,
            String brokerName
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record BrokerOrderResponse(
            boolean success,
            String  message,
            OrderData data
    ) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        public record OrderData(
                String clientOrderId,
                String brokerOrderId,
                String status,
                String statusMessage
        ) {}
    }

    // ─── API Calls ────────────────────────────────────────────────────────────

    /**
     * Submits an order to Broker Engine.
     *
     * @throws BrokerEngineException if the call fails or broker rejects
     */
    public BrokerOrderResponse placeOrder(PlaceOrderPayload payload) {
        try {
            String body = mapper.writeValueAsString(payload);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/broker/orders"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            log.debug("Broker Engine placeOrder response: status={}, body={}", resp.statusCode(), resp.body());

            if (resp.statusCode() >= 500) {
                throw new BrokerEngineException("Broker Engine server error: HTTP " + resp.statusCode());
            }

            return mapper.readValue(resp.body(), BrokerOrderResponse.class);

        } catch (BrokerEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new BrokerEngineException("Failed to call Broker Engine placeOrder: " + e.getMessage(), e);
        }
    }

    /**
     * Cancels an order via Broker Engine.
     */
    public BrokerOrderResponse cancelOrder(CancelOrderPayload payload) {
        try {
            String body = mapper.writeValueAsString(payload);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/broker/orders"))
                    .header("Content-Type", "application/json")
                    .method("DELETE", HttpRequest.BodyPublishers.ofString(body))
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            log.debug("Broker Engine cancelOrder response: status={}, body={}", resp.statusCode(), resp.body());

            if (resp.statusCode() >= 500) {
                throw new BrokerEngineException("Broker Engine server error: HTTP " + resp.statusCode());
            }

            return mapper.readValue(resp.body(), BrokerOrderResponse.class);

        } catch (BrokerEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new BrokerEngineException("Failed to call Broker Engine cancelOrder: " + e.getMessage(), e);
        }
    }

    /**
     * Fetches the current status of an order from Broker Engine.
     */
    public BrokerOrderResponse getOrderStatus(String clientOrderId) {
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/broker/orders/" + clientOrderId))
                    .GET()
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() >= 500) {
                throw new BrokerEngineException("Broker Engine server error: HTTP " + resp.statusCode());
            }

            return mapper.readValue(resp.body(), BrokerOrderResponse.class);

        } catch (BrokerEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new BrokerEngineException("Failed to call Broker Engine getOrderStatus: " + e.getMessage(), e);
        }
    }

    // ─── Exception ────────────────────────────────────────────────────────────

    public static class BrokerEngineException extends RuntimeException {
        public BrokerEngineException(String message) { super(message); }
        public BrokerEngineException(String message, Throwable cause) { super(message, cause); }
    }
}
