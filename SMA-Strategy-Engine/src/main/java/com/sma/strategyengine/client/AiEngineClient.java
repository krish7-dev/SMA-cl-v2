package com.sma.strategyengine.client;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Non-blocking HTTP client for SMA-AI-Engine advisory and review endpoints.
 * Returns CompletableFuture<Boolean> so callers can track post success/failure without blocking.
 */
@Slf4j
@Component
public class AiEngineClient {

    private final String          baseUrl;
    private final boolean         enabled;
    private final HttpClient      httpClient;
    private final ObjectMapper    mapper;
    private final ExecutorService executor;

    public AiEngineClient(
            @Value("${strategy.ai-engine.base-url:http://localhost:9007}") String baseUrl,
            @Value("${strategy.ai-engine.enabled:true}") boolean enabled,
            ObjectMapper mapper) {
        this.baseUrl    = baseUrl;
        this.enabled    = enabled;
        this.mapper     = mapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        this.executor = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "ai-engine-async");
            t.setDaemon(true);
            return t;
        });
    }

    /** Non-blocking POST to /api/v1/ai/advisory. Returns future that resolves true on HTTP 2xx, false otherwise. */
    public CompletableFuture<Boolean> adviseAsync(Map<String, Object> payload) {
        if (!enabled) return CompletableFuture.completedFuture(true);
        return CompletableFuture.supplyAsync(() -> post("/api/v1/ai/advisory", payload), executor);
    }

    /** Non-blocking POST to /api/v1/ai/review. Returns future that resolves true on HTTP 2xx, false otherwise. */
    public CompletableFuture<Boolean> reviewAsync(Map<String, Object> payload) {
        if (!enabled) return CompletableFuture.completedFuture(true);
        return CompletableFuture.supplyAsync(() -> post("/api/v1/ai/review", payload), executor);
    }

    private boolean post(String path, Map<String, Object> payload) {
        // Extract identifiers from payload for log correlation (best-effort, no NPE risk)
        String sessionId = extractStr(payload, "sessionId");
        String tradeId   = extractStr(payload, "tradeId");
        String candleTime = extractStr(payload, "candleTime");
        String logId     = tradeId != null ? "tradeId=" + tradeId
                         : candleTime != null ? "candle=" + candleTime
                         : "sessionId=" + sessionId;
        try {
            String body = mapper.writeValueAsString(payload);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn("AI Engine {} [{}] returned HTTP {}", path, logId, response.statusCode());
                return false;
            }
            return true;
        } catch (Exception e) {
            log.warn("AI Engine {} [{}] call failed: {}", path, logId, e.getMessage());
            return false;
        }
    }

    private static String extractStr(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v != null ? v.toString() : null;
    }
}
