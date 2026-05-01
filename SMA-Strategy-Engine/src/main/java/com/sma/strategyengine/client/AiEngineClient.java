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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Non-blocking HTTP client for SMA-AI-Engine advisory and review endpoints.
 * All calls fire-and-forget — exceptions are swallowed so the strategy loop is never affected.
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

    /** Fire-and-forget: POST trade candidate snapshot to /api/v1/ai/advisory. */
    public void adviseAsync(Map<String, Object> payload) {
        if (!enabled) return;
        executor.execute(() -> post("/api/v1/ai/advisory", payload));
    }

    /** Fire-and-forget: POST completed trade snapshot to /api/v1/ai/review. */
    public void reviewAsync(Map<String, Object> payload) {
        if (!enabled) return;
        executor.execute(() -> post("/api/v1/ai/review", payload));
    }

    private void post(String path, Map<String, Object> payload) {
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
                log.debug("AI Engine {} returned {}", path, response.statusCode());
            }
        } catch (Exception e) {
            log.debug("AI Engine {} call failed (non-blocking): {}", path, e.getMessage());
        }
    }
}
