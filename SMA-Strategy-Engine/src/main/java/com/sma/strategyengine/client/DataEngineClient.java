package com.sma.strategyengine.client;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.sma.strategyengine.service.options.LiveTickBuffer;
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
            String        apiKey,
            String        accessToken,
            Long          instrumentToken,
            String        symbol,
            String        exchange,
            String        interval,
            LocalDateTime fromDate,
            LocalDateTime toDate,
            boolean       persist
    ) {
        /** Convenience constructor — no credentials (Data Engine will auto-resolve from Broker Engine). */
        public HistoryRequest(String userId, String brokerName,
                              Long instrumentToken, String symbol, String exchange,
                              String interval, LocalDateTime fromDate, LocalDateTime toDate,
                              boolean persist) {
            this(userId, brokerName, null, null,
                 instrumentToken, symbol, exchange, interval, fromDate, toDate, persist);
        }
    }

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

    /**
     * Subscribes a list of instrument tokens to the Data Engine live tick stream.
     * Must be called before the tick SSE stream is consumed.
     *
     * @param userId        logical user id
     * @param brokerName    broker name (e.g. "kite")
     * @param apiKey        broker API key
     * @param accessToken   live access token
     * @param tokens        list of (instrumentToken, symbol, exchange) to subscribe
     * @throws DataEngineException on HTTP error or network failure
     */
    public void subscribe(String userId, String brokerName, String apiKey, String accessToken,
                          List<Map<String, Object>> tokens) {
        try {
            Map<String, Object> body = new java.util.LinkedHashMap<>();
            body.put("userId",       userId);
            body.put("brokerName",   brokerName);
            body.put("apiKey",       apiKey);
            body.put("accessToken",  accessToken);
            body.put("instruments",  tokens);
            body.put("mode",         "QUOTE");

            String json = mapper.writeValueAsString(body);

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/data/live/subscribe"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .timeout(Duration.ofSeconds(15))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new DataEngineException("Subscribe returned HTTP " + response.statusCode() + ": " + response.body());
            }
            log.info("DataEngineClient.subscribe: {} token(s) subscribed", tokens.size());

        } catch (DataEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new DataEngineException("Failed to subscribe to Data Engine: " + e.getMessage(), e);
        }
    }

    /**
     * Sends a batch of live-recorded candles to the Data Engine ingest endpoint.
     * Called by {@link com.sma.strategyengine.service.options.LiveCandleBuffer} — never on the hot tick path.
     *
     * @throws DataEngineException on HTTP error or network failure (caller handles retries)
     */
    public void ingestLiveCandles(String runId, String provider,
                                  List<com.sma.strategyengine.service.options.LiveCandleBuffer.BufferedCandle> batch) {
        try {
            // Build the LiveCandleIngestRequest payload
            List<Map<String, Object>> candlePayloads = batch.stream().map(c -> {
                Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("instrumentToken", c.instrumentToken());
                m.put("symbol",          c.symbol());
                m.put("exchange",        c.exchange());
                m.put("interval",        intervalFromKite(c.interval()));
                m.put("openTime",        c.openTime().toString());
                m.put("open",            c.open());
                m.put("high",            c.high());
                m.put("low",             c.low());
                m.put("close",           c.close());
                m.put("volume",          c.volume());
                m.put("openInterest",    0L);
                m.put("provider",        provider);
                m.put("sourceType",      "LIVE_RECORDED");
                return m;
            }).collect(java.util.stream.Collectors.toList());

            Map<String, Object> body = new java.util.LinkedHashMap<>();
            body.put("runId",      runId);
            body.put("provider",   provider);
            body.put("sourceType", "LIVE_RECORDED");
            body.put("candles",    candlePayloads);

            String json = mapper.writeValueAsString(body);

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/data/candles/ingest"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .timeout(Duration.ofSeconds(30))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new DataEngineException(
                        "Ingest returned HTTP " + response.statusCode() + ": " + response.body());
            }
        } catch (DataEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new DataEngineException("Failed to ingest live candles: " + e.getMessage(), e);
        }
    }

    /**
     * Sends a batch of raw live ticks to the Data Engine tick ingest endpoint.
     * Called by {@link com.sma.strategyengine.service.options.LiveTickBuffer}.
     */
    public void ingestLiveTicks(String sessionId, String provider,
                                List<com.sma.strategyengine.service.options.LiveTickBuffer.BufferedTick> batch) {
        try {
            List<Map<String, Object>> tickPayloads = batch.stream().map(t -> {
                Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("instrumentToken", t.instrumentToken());
                m.put("symbol",          t.symbol());
                m.put("exchange",        t.exchange());
                m.put("ltp",             t.ltp());
                m.put("volume",          t.volume());
                m.put("tickTime",        LiveTickBuffer.epochToIstString(t.epochMs()));
                return m;
            }).collect(java.util.stream.Collectors.toList());

            Map<String, Object> body = new java.util.LinkedHashMap<>();
            body.put("sessionId", sessionId);
            body.put("provider",  provider);
            body.put("ticks",     tickPayloads);

            String json = mapper.writeValueAsString(body);

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/data/ticks/ingest"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .timeout(Duration.ofSeconds(60))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new DataEngineException(
                        "Tick ingest returned HTTP " + response.statusCode() + ": " + response.body());
            }
        } catch (DataEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new DataEngineException("Failed to ingest live ticks: " + e.getMessage(), e);
        }
    }

    // ─── Tick Replay ──────────────────────────────────────────────────────────

    /** Tick session metadata returned by GET /api/v1/data/ticks/sessions. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TickSessionInfo(
            String        sessionId,
            LocalDateTime firstTick,
            LocalDateTime lastTick,
            long          tickCount,
            List<Long>    instrumentTokens) {}

    /** A single raw tick entry returned by POST /api/v1/data/ticks/query. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TickEntry(
            long   instrumentToken,
            double ltp,
            long   volume,
            long   tickTimeMs) {}

    /** Request body for POST /api/v1/data/ticks/query. */
    public record TickQueryPayload(
            String        sessionId,
            List<Long>    tokens,
            LocalDateTime fromDate,
            LocalDateTime toDate) {}

    /**
     * Lists all recorded tick sessions from the Data Engine (newest first).
     * Returns empty list on any error.
     */
    @SuppressWarnings("unchecked")
    public List<TickSessionInfo> listTickSessions() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/data/ticks/sessions"))
                    .header("Accept", "application/json")
                    .GET()
                    .timeout(Duration.ofSeconds(30))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn("listTickSessions: HTTP {}", response.statusCode());
                return List.of();
            }
            Map<String, Object> envelope = mapper.readValue(response.body(), new TypeReference<>() {});
            Object dataNode = envelope.get("data");
            if (dataNode == null) return List.of();
            return mapper.convertValue(dataNode, new TypeReference<List<TickSessionInfo>>() {});
        } catch (Exception e) {
            log.warn("listTickSessions failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * Fetches raw ticks for the given session and token list, sorted by tick_time.
     *
     * @throws DataEngineException on HTTP error or network failure
     */
    public List<TickEntry> fetchSessionTicks(TickQueryPayload req) {
        try {
            String body = mapper.writeValueAsString(req);

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/data/ticks/query"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .timeout(Duration.ofSeconds(120))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new DataEngineException(
                        "Tick query returned HTTP " + response.statusCode() + ": " + response.body());
            }

            Map<String, Object> envelope = mapper.readValue(response.body(), new TypeReference<>() {});
            Object dataNode = envelope.get("data");
            if (dataNode == null) return List.of();
            return mapper.convertValue(dataNode, new TypeReference<List<TickEntry>>() {});

        } catch (DataEngineException e) {
            throw e;
        } catch (Exception e) {
            throw new DataEngineException("Failed to fetch session ticks: " + e.getMessage(), e);
        }
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /** Converts a Kite interval string (e.g. "5minute") back to the Strategy Engine enum name (e.g. "MINUTE_5"). */
    private static String intervalFromKite(String kiteValue) {
        return switch (kiteValue) {
            case "minute"   -> "MINUTE_1";
            case "3minute"  -> "MINUTE_3";
            case "5minute"  -> "MINUTE_5";
            case "10minute" -> "MINUTE_10";
            case "15minute" -> "MINUTE_15";
            case "30minute" -> "MINUTE_30";
            case "60minute" -> "MINUTE_60";
            case "day"      -> "DAY";
            default         -> kiteValue;
        };
    }

    // ─── Exception ────────────────────────────────────────────────────────────

    public static class DataEngineException extends RuntimeException {
        public DataEngineException(String message)              { super(message); }
        public DataEngineException(String message, Throwable t) { super(message, t); }
    }
}
