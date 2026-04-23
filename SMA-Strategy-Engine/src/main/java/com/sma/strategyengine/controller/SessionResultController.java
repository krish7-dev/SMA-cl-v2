package com.sma.strategyengine.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.entity.SessionFeedChunkRecord;
import com.sma.strategyengine.entity.SessionResultRecord;
import com.sma.strategyengine.model.response.ApiResponse;
import com.sma.strategyengine.repository.SessionFeedChunkRepository;
import com.sma.strategyengine.repository.SessionResultRepository;
import com.sma.strategyengine.service.options.SessionDivergenceAnalyzer;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * Endpoints for persisting and retrieving session comparison results.
 *
 * <pre>
 * POST   /api/v1/strategy/session-results               — save a session result
 * GET    /api/v1/strategy/session-results?userId=&type= — list results (metadata only)
 * GET    /api/v1/strategy/session-results/{sessionId}   — get full result (with feed + trades)
 * DELETE /api/v1/strategy/session-results/{sessionId}   — delete
 * </pre>
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/strategy/session-results")
@RequiredArgsConstructor
public class SessionResultController {

    private final SessionResultRepository   repository;
    private final SessionFeedChunkRepository chunkRepository;
    private final ObjectMapper              objectMapper;
    private final SessionDivergenceAnalyzer divergenceAnalyzer;

    // ── Request DTO ───────────────────────────────────────────────────────────

    @Data
    public static class SaveRequest {
        private String  sessionId;
        private String  type;          // "LIVE" | "TICK_REPLAY"
        private String  userId;
        private String  brokerName;
        private String  sessionDate;   // ISO date "2024-01-15" — parsed to LocalDate
        private String  label;
        private Object  config;        // raw JSON object — serialised to string
        private Object  closedTrades;  // raw JSON array
        private Object  feed;          // raw JSON array
        private Object  ticks;         // raw JSON array of tick events ({token, ltp, timeMs})
        private Object  summary;       // raw JSON object
    }

    // ── Endpoints ─────────────────────────────────────────────────────────────

    @PostMapping
    public ResponseEntity<ApiResponse<Map<String, String>>> save(
            @RequestBody SaveRequest req) {

        try {
            String configJson       = req.getConfig()       != null ? objectMapper.writeValueAsString(req.getConfig())       : null;
            String closedTradesJson = req.getClosedTrades()  != null ? objectMapper.writeValueAsString(req.getClosedTrades())  : null;
            String feedJson         = req.getFeed()          != null ? objectMapper.writeValueAsString(req.getFeed())          : null;
            String ticksJson        = req.getTicks()         != null ? objectMapper.writeValueAsString(req.getTicks())         : null;
            String summaryJson      = req.getSummary()       != null ? objectMapper.writeValueAsString(req.getSummary())       : null;

            LocalDate date = null;
            if (req.getSessionDate() != null && !req.getSessionDate().isBlank()) {
                try { date = LocalDate.parse(req.getSessionDate()); } catch (Exception ignored) {}
            }
            if (date == null) date = LocalDate.now();

            SessionResultRecord record = SessionResultRecord.builder()
                    .sessionId(req.getSessionId())
                    .type(req.getType())
                    .userId(req.getUserId())
                    .brokerName(req.getBrokerName())
                    .sessionDate(date)
                    .label(req.getLabel())
                    .configJson(configJson)
                    .closedTradesJson(closedTradesJson)
                    .feedJson(feedJson)
                    .ticksJson(ticksJson)
                    .summaryJson(summaryJson)
                    .savedAt(Instant.now())
                    .build();

            repository.save(record);
            log.info("Session result saved: sessionId={} type={} userId={} label={}",
                    req.getSessionId(), req.getType(), req.getUserId(), req.getLabel());

            return ResponseEntity.ok(ApiResponse.ok(Map.of("sessionId", req.getSessionId())));

        } catch (Exception e) {
            log.error("Failed to save session result {}: {}", req.getSessionId(), e.getMessage());
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error("Failed to save: " + e.getMessage()));
        }
    }

    @GetMapping
    public ResponseEntity<ApiResponse<List<SessionResultRecord>>> list(
            @RequestParam(required = false) String userId,
            @RequestParam(required = false) String type) {

        List<SessionResultRecord> results;
        if (userId != null && !userId.isBlank()) {
            results = (type != null && !type.isBlank())
                    ? repository.findMetadataByUserIdAndType(userId, type)
                    : repository.findMetadataByUserId(userId);
        } else {
            results = (type != null && !type.isBlank())
                    ? repository.findMetadataByType(type)
                    : repository.findAllMetadata();
        }
        return ResponseEntity.ok(ApiResponse.ok(results));
    }

    @GetMapping("/{sessionId}")
    public ResponseEntity<ApiResponse<SessionResultRecord>> get(
            @PathVariable String sessionId) {

        return repository.findById(sessionId)
                .map(r -> {
                    // If feed_json is absent (new chunk-based auto-save), assemble from chunk table.
                    // If feed_json is present (manual save or old auto-save), use it as-is.
                    if ((r.getFeedJson() == null || r.getFeedJson().isBlank())
                            && chunkRepository.existsBySessionId(sessionId)) {
                        r.setFeedJson(assembleFromChunks(sessionId));
                    }
                    return ResponseEntity.ok(ApiResponse.ok(r));
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{sessionId}")
    public ResponseEntity<ApiResponse<Void>> delete(
            @PathVariable String sessionId) {

        chunkRepository.deleteBySessionId(sessionId);
        repository.deleteBySessionId(sessionId);
        log.info("Session result deleted: sessionId={}", sessionId);
        return ResponseEntity.ok(ApiResponse.ok(null));
    }

    /**
     * Concatenates all chunk JSON arrays for a session into one JSON array string.
     * Each chunk is stored as a JSON array, e.g. [{...},{...}].
     * The result is a single flat array of all candle events in insertion order.
     */
    private String assembleFromChunks(String sessionId) {
        java.util.List<SessionFeedChunkRecord> chunks =
                chunkRepository.findBySessionIdOrderByIdAsc(sessionId);
        if (chunks.isEmpty()) return "[]";

        StringBuilder sb = new StringBuilder("[");
        boolean firstItem = true;
        for (SessionFeedChunkRecord chunk : chunks) {
            String json = chunk.getChunkJson().trim();
            // Strip the outer [ ] from each chunk array and join the inner items
            if (json.startsWith("[") && json.endsWith("]")) {
                json = json.substring(1, json.length() - 1).trim();
            }
            if (!json.isEmpty()) {
                if (!firstItem) sb.append(",");
                sb.append(json);
                firstItem = false;
            }
        }
        sb.append("]");
        return sb.toString();
    }

    /**
     * Compares two saved sessions field-by-field and returns the first divergence.
     *
     * <pre>
     * GET /api/v1/strategy/session-results/divergence?sessionA={liveId}&sessionB={replayId}
     * </pre>
     */
    @GetMapping("/divergence")
    public ResponseEntity<ApiResponse<SessionDivergenceAnalyzer.DivergenceReport>> divergence(
            @RequestParam String sessionA,
            @RequestParam String sessionB) {

        try {
            SessionDivergenceAnalyzer.DivergenceReport report =
                    divergenceAnalyzer.analyze(sessionA, sessionB);
            return ResponseEntity.ok(ApiResponse.ok(report));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest()
                    .body(ApiResponse.error(e.getMessage()));
        } catch (Exception e) {
            log.error("Divergence analysis failed {}/{}: {}", sessionA, sessionB, e.getMessage());
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error("Analysis failed: " + e.getMessage()));
        }
    }
}
