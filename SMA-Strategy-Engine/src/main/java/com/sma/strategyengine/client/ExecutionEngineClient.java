package com.sma.strategyengine.client;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * HTTP client for the SMA-Execution-Engine.
 *
 * Strategy Engine NEVER calls Broker Engine directly — all order placement
 * flows through Execution Engine, which handles broker routing, risk checks,
 * and idempotency.
 */
@Slf4j
@Component
public class ExecutionEngineClient {

    private final String      baseUrl;
    private final HttpClient  httpClient;
    private final ObjectMapper mapper;

    public ExecutionEngineClient(
            @Value("${strategy.execution-engine.base-url:http://localhost:9004}") String baseUrl,
            ObjectMapper mapper) {
        this.baseUrl    = baseUrl;
        this.mapper     = mapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    // ─── Records ──────────────────────────────────────────────────────────────

    /**
     * Payload sent to POST /api/v1/execution/orders.
     * Mirrors ExecutionEngine's ExecutionRequest.
     */
    public record PlaceIntentPayload(
            String     intentId,
            String     userId,
            String     brokerName,
            String     symbol,
            String     exchange,
            String     side,
            String     orderType,
            String     product,
            int        quantity,
            BigDecimal price,
            BigDecimal triggerPrice,
            String     validity,
            String     tag
    ) {}

    public record IntentResponse(
            boolean success,
            String  message,
            IntentData data
    ) {}

    public record IntentData(
            String intentId,
            String brokerClientOrderId,
            String status,
            String errorMessage
    ) {}

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Sends an order intent to Execution Engine.
     *
     * @throws ExecutionEngineException on HTTP or network error
     */
    public IntentResponse placeIntent(PlaceIntentPayload payload) {
        try {
            String body = mapper.writeValueAsString(payload);

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/execution/orders"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .timeout(Duration.ofSeconds(15))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                return mapper.readValue(response.body(), IntentResponse.class);
            }

            String errorMsg = "Execution Engine returned HTTP " + response.statusCode() + ": " + response.body();
            log.warn(errorMsg);
            throw new ExecutionEngineException(errorMsg);

        } catch (ExecutionEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new ExecutionEngineException("Failed to reach Execution Engine: " + e.getMessage(), e);
        }
    }

    // ─── Exception ────────────────────────────────────────────────────────────

    public static class ExecutionEngineException extends RuntimeException {
        public ExecutionEngineException(String message)              { super(message); }
        public ExecutionEngineException(String message, Throwable t) { super(message, t); }
    }
}
