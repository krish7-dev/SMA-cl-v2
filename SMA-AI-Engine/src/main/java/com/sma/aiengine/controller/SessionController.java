package com.sma.aiengine.controller;

import com.sma.aiengine.model.response.ApiResponse;
import com.sma.aiengine.model.response.SessionSummaryResponse;
import com.sma.aiengine.repository.AdvisoryRepository;
import com.sma.aiengine.repository.TradeReviewRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.*;

@RestController
@RequestMapping("/api/v1/ai/sessions")
@RequiredArgsConstructor
public class SessionController {

    private final AdvisoryRepository    advisoryRepository;
    private final TradeReviewRepository tradeReviewRepository;

    /**
     * Returns all distinct session IDs with advisory/review counts and latest activity.
     * GET /api/v1/ai/sessions
     */
    @GetMapping
    public ResponseEntity<ApiResponse<List<SessionSummaryResponse>>> sessions() {
        Map<String, long[]>   counts = new LinkedHashMap<>();
        Map<String, Instant>  latest = new HashMap<>();

        advisoryRepository.findSessionSummaries().forEach(row -> {
            String  sid = (String) row[0];
            long    cnt = ((Number) row[1]).longValue();
            Instant ts  = (Instant) row[2];
            counts.computeIfAbsent(sid, k -> new long[2])[0] = cnt;
            latest.merge(sid, ts, (a, b) -> a.isAfter(b) ? a : b);
        });

        tradeReviewRepository.findSessionSummaries().forEach(row -> {
            String  sid = (String) row[0];
            long    cnt = ((Number) row[1]).longValue();
            Instant ts  = (Instant) row[2];
            counts.computeIfAbsent(sid, k -> new long[2])[1] = cnt;
            latest.merge(sid, ts, (a, b) -> a.isAfter(b) ? a : b);
        });

        List<SessionSummaryResponse> result = counts.entrySet().stream()
                .map(e -> new SessionSummaryResponse(
                        e.getKey(),
                        e.getValue()[0],
                        e.getValue()[1],
                        latest.get(e.getKey())
                ))
                .sorted(Comparator.comparing(SessionSummaryResponse::latestActivity).reversed())
                .toList();

        return ResponseEntity.ok(ApiResponse.ok(result));
    }
}
