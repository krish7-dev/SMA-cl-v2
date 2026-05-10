package com.sma.strategyengine.client;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Non-blocking HTTP client for SMA-AI-Engine advisory, review, and market-context endpoints.
 * Returns CompletableFuture so callers can track success/failure without blocking.
 */
@Slf4j
@Component
public class AiEngineClient {

    /**
     * Cached result of a market-context evaluation.
     * Stored as a volatile field in LiveOptionsSession — read on every tick entry check, no locking.
     */
    public record CachedAiMarketContext(
            boolean      marketTradable,
            boolean      avoidCE,
            boolean      avoidPE,
            double       confidence,
            String       summary,
            List<String> reasonCodes,
            List<String> warningCodes,
            String       source,        // "OPENAI" / "FALLBACK"
            long         timestampMs,
            long         validUntilMs
    ) {
        public boolean isExpired() { return System.currentTimeMillis() > validUntilMs; }
    }

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

    /**
     * Non-blocking POST to /api/v1/ai/market-context.
     * Returns a future that resolves to a {@link CachedAiMarketContext} on success, or null on any failure.
     * The caller treats null (or an expired entry) as fail-open — no blocking, no gate.
     *
     * @param payload    MarketContextRequest fields serialised as a Map (built by LiveOptionsSession)
     * @param ttlSeconds How long the cached result is considered valid
     */
    public CompletableFuture<CachedAiMarketContext> fetchMarketContextAsync(
            Map<String, Object> payload, int ttlSeconds) {
        if (!enabled) return CompletableFuture.completedFuture(null);
        return CompletableFuture.supplyAsync(
                () -> postMarketContext("/api/v1/ai/market-context", payload, ttlSeconds),
                executor);
    }

    private CachedAiMarketContext postMarketContext(String path, Map<String, Object> payload, int ttlSeconds) {
        String sessionId  = extractStr(payload, "sessionId");
        String candleTime = extractStr(payload, "candleTime");
        String logId      = "session=" + sessionId + " candle=" + candleTime;
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
                return null;
            }
            return parseMarketContext(response.body(), ttlSeconds);
        } catch (Exception e) {
            log.warn("AI Engine {} [{}] call failed: {}", path, logId, e.getMessage());
            return null;
        }
    }

    private CachedAiMarketContext parseMarketContext(String responseBody, int ttlSeconds) {
        try {
            JsonNode root = mapper.readTree(responseBody);
            JsonNode data = root.path("data");
            if (data.isMissingNode() || data.isNull()) return null;

            boolean      marketTradable = data.path("marketTradable").asBoolean(true);
            boolean      avoidCE        = data.path("avoidCE").asBoolean(false);
            boolean      avoidPE        = data.path("avoidPE").asBoolean(false);
            double       confidence     = Math.max(0.0, Math.min(1.0, data.path("confidence").asDouble(0.5)));
            String       summary        = data.path("summary").asText("");
            String       source         = data.path("source").asText("FALLBACK");

            List<String> reasonCodes  = new ArrayList<>();
            List<String> warningCodes = new ArrayList<>();
            JsonNode rcNode = data.path("reasonCodes");
            if (rcNode.isArray()) rcNode.forEach(n -> { if (n.isTextual()) reasonCodes.add(n.asText()); });
            JsonNode wcNode = data.path("warningCodes");
            if (wcNode.isArray()) wcNode.forEach(n -> { if (n.isTextual()) warningCodes.add(n.asText()); });

            long now = System.currentTimeMillis();
            return new CachedAiMarketContext(
                    marketTradable, avoidCE, avoidPE, confidence,
                    summary, List.copyOf(reasonCodes), List.copyOf(warningCodes),
                    source, now, now + ttlSeconds * 1000L);
        } catch (Exception e) {
            log.warn("AI Engine market-context response parse failed: {}", e.getMessage());
            return null;
        }
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
