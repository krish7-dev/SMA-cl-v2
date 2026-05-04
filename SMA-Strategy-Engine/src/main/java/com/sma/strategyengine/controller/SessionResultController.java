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
import org.springframework.data.domain.PageRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

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
        // feedJson intentionally excluded — feed lives in session_feed_chunk to avoid OOM.
        // Use the /feed endpoint when the full candle feed is needed for display/comparison.
        return repository.findById(sessionId)
                .map(r -> { r.setFeedJson(null); return ResponseEntity.ok(ApiResponse.ok(r)); })
                .orElse(ResponseEntity.notFound().build());
    }

    @Data
    public static class FinalizeRequest {
        private String label;
        private Object summary;
        private Object closedTrades;
    }

    @PatchMapping("/{sessionId}")
    public ResponseEntity<ApiResponse<Map<String, String>>> finalize(
            @PathVariable String sessionId,
            @RequestBody FinalizeRequest req) {
        try {
            String summaryJson      = req.getSummary()      != null ? objectMapper.writeValueAsString(req.getSummary())      : null;
            String closedTradesJson = req.getClosedTrades() != null ? objectMapper.writeValueAsString(req.getClosedTrades()) : null;
            repository.finalizeSession(sessionId, req.getLabel() != null ? req.getLabel() : "", summaryJson, closedTradesJson);
            log.info("Session finalized: sessionId={} label={}", sessionId, req.getLabel());
            return ResponseEntity.ok(ApiResponse.ok(Map.of("sessionId", sessionId)));
        } catch (Exception e) {
            log.error("Failed to finalize session {}: {}", sessionId, e.getMessage());
            return ResponseEntity.internalServerError().body(ApiResponse.error("Failed to finalize: " + e.getMessage()));
        }
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
     * Compares two saved sessions field-by-field and returns the first divergence.
     *
     * <pre>
     * GET /api/v1/strategy/session-results/divergence?sessionA={liveId}&sessionB={replayId}
     * </pre>
     */
    // ── Feed chunk DTO ────────────────────────────────────────────────────────

    public record FeedChunkDto(
            Long          id,
            String        sessionId,
            String        chunkJson,
            OffsetDateTime savedAt,
            String        streamLastId) {}

    // ── Paginated feed-chunks endpoint ────────────────────────────────────────

    /**
     * Cursor-paginated access to raw session_feed_chunk rows.
     * Walk forward by passing the last returned {@code id} as {@code afterId} in the next call.
     * Each item's {@code chunkJson} is a JSON array of candle events (up to 200 per row).
     *
     * <pre>
     * GET /api/v1/strategy/session-results/{sessionId}/feed-chunks?afterId=0&amp;limit=10
     * </pre>
     */
    @GetMapping("/{sessionId}/feed-chunks")
    public ResponseEntity<ApiResponse<List<FeedChunkDto>>> getFeedChunks(
            @PathVariable String sessionId,
            @RequestParam(defaultValue = "0")  long afterId,
            @RequestParam(defaultValue = "10") int  limit) {

        int capped = Math.min(limit, 50);
        List<SessionFeedChunkRecord> rows = chunkRepository.findBySessionIdAfterIdOrderByIdAsc(
                sessionId, afterId, PageRequest.of(0, capped));

        List<FeedChunkDto> dtos = rows.stream()
                .map(r -> new FeedChunkDto(
                        r.getId(),
                        r.getSessionId(),
                        r.getChunkJson(),
                        r.getSavedAt() != null ? r.getSavedAt().atOffset(ZoneOffset.UTC) : null,
                        r.getStreamLastId()))
                .collect(Collectors.toList());

        return ResponseEntity.ok(ApiResponse.ok(dtos));
    }

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
