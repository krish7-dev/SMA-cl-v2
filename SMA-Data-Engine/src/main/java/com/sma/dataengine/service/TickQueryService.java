package com.sma.dataengine.service;

import com.sma.dataengine.model.TickRecord;
import com.sma.dataengine.model.request.TickQueryRequest;
import com.sma.dataengine.model.response.TickEntryDto;
import com.sma.dataengine.model.response.TickSessionInfo;
import com.sma.dataengine.repository.CandleRepository;
import com.sma.dataengine.repository.TickRecordRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Provides tick session listing and raw tick query for the tick replay feature.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TickQueryService {

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private final TickRecordRepository repo;
    private final CandleRepository     candleRepo;

    // ─── Session listing ──────────────────────────────────────────────────────

    /**
     * Returns metadata for all tick sessions, newest first.
     */
    @Transactional(readOnly = true)
    public List<TickSessionInfo> listSessions() {
        List<Object[]> rows = repo.findSessionSummaries();
        List<TickSessionInfo> result = new ArrayList<>(rows.size());
        for (Object[] row : rows) {
            try {
                String        sessionId = (String) row[0];
                LocalDateTime firstTick = toLocalDateTime(row[1]);
                LocalDateTime lastTick  = toLocalDateTime(row[2]);
                long          tickCount = ((Number) row[3]).longValue();
                List<Long>    tokens    = toTokenList(row[4]);
                Map<Long, String> tokenSymbols = resolveSymbols(tokens);
                result.add(TickSessionInfo.builder()
                        .sessionId(sessionId)
                        .firstTick(firstTick)
                        .lastTick(lastTick)
                        .tickCount(tickCount)
                        .instrumentTokens(tokens)
                        .tokenSymbols(tokenSymbols)
                        .build());
            } catch (Exception e) {
                log.warn("Failed to parse session summary row: {}", e.getMessage());
            }
        }
        return result;
    }

    // ─── Tick query ───────────────────────────────────────────────────────────

    /**
     * Fetches raw ticks for the given session and tokens, ordered by tick_time.
     * Optionally filters to a sub-range within the session.
     */
    @Transactional(readOnly = true)
    public List<TickEntryDto> queryTicks(TickQueryRequest req) {
        if (req.getTokens() == null || req.getTokens().isEmpty()) {
            return List.of();
        }

        List<TickRecord> records = repo.findBySessionIdAndTokensOrdered(
                req.getSessionId(), req.getTokens());

        return records.stream()
                .filter(r -> {
                    if (req.getFromDate() != null && r.getTickTime().isBefore(req.getFromDate())) return false;
                    if (req.getToDate()   != null && r.getTickTime().isAfter(req.getToDate()))   return false;
                    return true;
                })
                .map(r -> TickEntryDto.builder()
                        .instrumentToken(r.getInstrumentToken())
                        .ltp(r.getLtp().doubleValue())
                        .volume(r.getVolume() != null ? r.getVolume() : 0L)
                        .tickTimeMs(r.getTickTime().atZone(IST).toInstant().toEpochMilli())
                        .build())
                .collect(Collectors.toList());
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private Map<Long, String> resolveSymbols(List<Long> tokens) {
        if (tokens == null || tokens.isEmpty()) return Map.of();
        try {
            Map<Long, String> map = new HashMap<>();
            candleRepo.findSymbolsByTokens(tokens)
                    .forEach(row -> {
                        Long   token  = ((Number) row[0]).longValue();
                        String symbol = (String) row[1];
                        if (symbol != null && !symbol.isBlank()) map.put(token, symbol);
                    });
            return map;
        } catch (Exception e) {
            log.warn("Could not resolve symbols for tokens: {}", e.getMessage());
            return Map.of();
        }
    }

    private static LocalDateTime toLocalDateTime(Object val) {
        if (val instanceof LocalDateTime ldt) return ldt;
        if (val instanceof java.sql.Timestamp ts) return ts.toLocalDateTime();
        if (val instanceof java.time.OffsetDateTime odt) return odt.toLocalDateTime();
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<Long> toTokenList(Object val) {
        if (val == null) return List.of();
        // PostgreSQL ARRAY_AGG returns a java.sql.Array or Long[]
        try {
            if (val instanceof java.sql.Array arr) {
                Object[] array = (Object[]) arr.getArray();
                return Arrays.stream(array)
                        .filter(o -> o instanceof Number)
                        .map(o -> ((Number) o).longValue())
                        .collect(Collectors.toList());
            }
            if (val instanceof Long[] arr) {
                return Arrays.asList(arr);
            }
            if (val instanceof Object[] arr) {
                return Arrays.stream(arr)
                        .filter(o -> o instanceof Number)
                        .map(o -> ((Number) o).longValue())
                        .collect(Collectors.toList());
            }
        } catch (Exception e) {
            log.warn("Could not parse token array from session summary: {}", e.getMessage());
        }
        return List.of();
    }
}
