package com.sma.strategyengine.client;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.core.type.TypeReference;
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
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * HTTP client for the SMA-Data-Engine historical data endpoint.
 *
 * Used exclusively for backtesting — fetches stored candles so the
 * Strategy Engine can replay them through strategy logic offline.
 * Strategy Engine never calls Broker Engine directly.
 */
@Slf4j
@Component
public class DataEngineClient {

    private final String     baseUrl;
    private final HttpClient httpClient;
    private final ObjectMapper mapper;

    public DataEngineClient(
            @Value("${strategy.data-engine.base-url:http://localhost:9005}") String baseUrl,
            ObjectMapper mapper) {
        this.baseUrl    = baseUrl;
        this.mapper     = mapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    // ─── Records ──────────────────────────────────────────────────────────────

    /**
     * Payload sent to POST /api/v1/data/history.
     * "interval" must be the Interval enum NAME (e.g. "MINUTE_5", "DAY").
     */
    public record HistoryRequest(
            String        userId,
            String        brokerName,
            Long          instrumentToken,
            String        symbol,
            String        exchange,
            String        interval,
            LocalDateTime fromDate,
            LocalDateTime toDate,
            boolean       persist
    ) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record CandleDto(
            LocalDateTime openTime,
            BigDecimal    open,
            BigDecimal    high,
            BigDecimal    low,
            BigDecimal    close,
            Long          volume
    ) {}

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Fetches historical candles from Data Engine.
     *
     * @throws DataEngineException on HTTP error or network failure
     */
    public List<CandleDto> fetchHistory(HistoryRequest request) {
        try {
            String body = mapper.writeValueAsString(request);

            HttpRequest httpRequest = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/data/history"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .timeout(Duration.ofSeconds(300))  // sub-15min intervals can yield 10k+ candles
                    .build();

            HttpResponse<String> response = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new DataEngineException("Data Engine returned HTTP " + response.statusCode() + ": " + response.body());
            }

            // Parse ApiResponse<List<CandleDto>>
            Map<String, Object> envelope = mapper.readValue(response.body(), new TypeReference<>() {});
            Object dataNode = envelope.get("data");
            if (dataNode == null) return List.of();

            return mapper.convertValue(dataNode, new TypeReference<List<CandleDto>>() {});

        } catch (DataEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new DataEngineException("Failed to reach Data Engine: " + e.getMessage(), e);
        }
    }

    // ─── Exception ────────────────────────────────────────────────────────────

    public static class DataEngineException extends RuntimeException {
        public DataEngineException(String message)              { super(message); }
        public DataEngineException(String message, Throwable t) { super(message, t); }
    }
}
