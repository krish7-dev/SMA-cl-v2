package com.sma.strategyengine.service.options;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.repository.SessionResultRepository;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.*;

/**
 * Compares two saved session feeds (A vs B) to pinpoint the first
 * divergence — candle OHLCV, regime, signal, or execution layer.
 *
 * <p>Uses {@code niftyTime} as the join key. Both feeds must have been saved
 * after Fix-1 (niftyTime = bucket-start, not actual tick time) for the key
 * to match reliably.
 *
 * <p>A and B are neutral labels — neither is assumed to be LIVE or REPLAY.
 * The caller passes sessionA/sessionB in whichever order they chose in the UI.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SessionDivergenceAnalyzer {

    private final SessionResultRepository repository;
    private final ObjectMapper            objectMapper;

    // ── Tolerances ────────────────────────────────────────────────────────────

    private static final double OHLC_TOL      = 0.05;
    private static final double SCORE_TOL     = 0.5;
    private static final double PRICE_TOL     = 0.5;
    private static final long   TRADE_TOL_MS  = 60_000L;   // ±1 min

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    // ── Report POJOs ──────────────────────────────────────────────────────────

    @Data @Builder
    public static class FieldDiff {
        /** niftyTime of the bucket where the divergence was detected. */
        private String niftyTime;
        /** CANDLE | REGIME | SIGNAL | EXECUTION */
        private String stage;
        private String field;
        private Object aValue;
        private Object bValue;
    }

    @Data @Builder
    public static class TradeMatch {
        private String  aEntryTime;
        private String  bEntryTime;
        /** CE or PE */
        private String  side;
        private boolean entryPriceMismatch;   // |a − b| > PRICE_TOL
        private boolean exitPriceMismatch;
        private boolean exitReasonMismatch;
        private double  pnlDiff;              // b.pnl − a.pnl
        /** MATCHED | A_ONLY | B_ONLY */
        private String  status;
    }

    @Data @Builder
    public static class DivergenceReport {
        private String sessionA;
        private String sessionB;
        private int    matchedCandles;
        private int    aOnlyCount;
        private int    bOnlyCount;
        private int    divergentCandleCount;
        /** niftyTime of first candle that differs in any stage (partial-start buckets excluded). */
        private String firstDivergenceTime;
        /** Stage of first difference: CANDLE | REGIME | SIGNAL | EXECUTION */
        private String firstDivergenceStage;
        private List<FieldDiff>  divergences;
        private List<String>     aOnlyTimes;
        private List<String>     bOnlyTimes;
        /** Times that are only in one session AND are that session's first candle (startup alignment gap). */
        private List<String>     partialStartBuckets;
        private List<TradeMatch> tradeComparison;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public DivergenceReport analyze(String sessionA, String sessionB) {
        var recA = repository.findById(sessionA).orElseThrow(() ->
                new IllegalArgumentException("Session not found: " + sessionA));
        var recB = repository.findById(sessionB).orElseThrow(() ->
                new IllegalArgumentException("Session not found: " + sessionB));

        List<Map<String, Object>> feedA = parseArray(recA.getFeedJson());
        List<Map<String, Object>> feedB = parseArray(recB.getFeedJson());

        // Index by niftyTime — preserving original insertion order
        LinkedHashMap<String, Map<String, Object>> mapA = indexBy(feedA, "niftyTime");
        LinkedHashMap<String, Map<String, Object>> mapB = indexBy(feedB, "niftyTime");

        // Stable union of all niftyTime keys in encounter order
        Set<String> allTimes = new LinkedHashSet<>();
        allTimes.addAll(mapA.keySet());
        allTimes.addAll(mapB.keySet());

        // Detect partial start buckets: first candle of A or B that the other session doesn't have.
        // This happens when a session attaches to the tick stream mid-bucket and therefore misses
        // the partial first candle that the other session did accumulate.
        String firstKeyA = mapA.isEmpty() ? null : mapA.keySet().iterator().next();
        String firstKeyB = mapB.isEmpty() ? null : mapB.keySet().iterator().next();
        List<String> partialStartBuckets = new ArrayList<>();
        if (firstKeyA != null && !mapB.containsKey(firstKeyA)) {
            partialStartBuckets.add(firstKeyA);
        }
        if (firstKeyB != null && !mapA.containsKey(firstKeyB)
                && !firstKeyB.equals(firstKeyA)) {
            partialStartBuckets.add(firstKeyB);
        }
        Set<String> partialSet = new HashSet<>(partialStartBuckets);

        List<String>    aOnly       = new ArrayList<>();
        List<String>    bOnly       = new ArrayList<>();
        List<FieldDiff> divergences = new ArrayList<>();
        Set<String>     divergentTimes = new LinkedHashSet<>();

        for (String t : allTimes) {
            boolean inA = mapA.containsKey(t);
            boolean inB = mapB.containsKey(t);
            if (!inA) { bOnly.add(t); continue; }
            if (!inB) { aOnly.add(t); continue; }
            compareCandle(t, mapA.get(t), mapB.get(t), divergences, divergentTimes);
        }

        // First divergence across all stages — skip partial-start buckets
        String firstTime  = null;
        String firstStage = null;
        for (FieldDiff d : divergences) {
            if (!partialSet.contains(d.getNiftyTime())) {
                firstTime  = d.getNiftyTime();
                firstStage = d.getStage();
                break;
            }
        }
        // Also consider aOnly/bOnly times as first divergence if they precede field diffs
        String firstOnlyTime = null;
        for (String t : allTimes) {
            if (partialSet.contains(t)) continue;
            if (!mapA.containsKey(t) || !mapB.containsKey(t)) { firstOnlyTime = t; break; }
        }
        if (firstOnlyTime != null && (firstTime == null || firstOnlyTime.compareTo(firstTime) < 0)) {
            firstTime  = firstOnlyTime;
            firstStage = mapA.containsKey(firstOnlyTime) ? "A_ONLY" : "B_ONLY";
        }

        int matched = (int) allTimes.stream()
                .filter(t -> mapA.containsKey(t) && mapB.containsKey(t))
                .count();

        List<TradeMatch> trades = compareTrades(
                parseArray(recA.getClosedTradesJson()),
                parseArray(recB.getClosedTradesJson()));

        log.info("Divergence analysis {}/{}: matched={} aOnly={} bOnly={} "
                + "divergentBuckets={} partialStart={} firstAt={} firstStage={}",
                sessionA, sessionB, matched,
                aOnly.size(), bOnly.size(), divergentTimes.size(),
                partialStartBuckets, firstTime, firstStage);

        return DivergenceReport.builder()
                .sessionA(sessionA)
                .sessionB(sessionB)
                .matchedCandles(matched)
                .aOnlyCount(aOnly.size())
                .bOnlyCount(bOnly.size())
                .divergentCandleCount(divergentTimes.size())
                .firstDivergenceTime(firstTime)
                .firstDivergenceStage(firstStage)
                .divergences(divergences)
                .aOnlyTimes(aOnly)
                .bOnlyTimes(bOnly)
                .partialStartBuckets(partialStartBuckets)
                .tradeComparison(trades)
                .build();
    }

    // ── Stage comparators ─────────────────────────────────────────────────────

    private void compareCandle(String t,
                                Map<String, Object> a,
                                Map<String, Object> b,
                                List<FieldDiff> out,
                                Set<String> divergentTimes) {

        // CANDLE stage — OHLCV
        for (String f : List.of("niftyOpen", "niftyHigh", "niftyLow", "niftyClose")) {
            if (numericDiverges(a.get(f), b.get(f), OHLC_TOL)) {
                out.add(diff(t, "CANDLE", f, a.get(f), b.get(f)));
                divergentTimes.add(t);
            }
        }

        // REGIME stage
        if (strDiverges(a.get("regime"), b.get("regime"))) {
            out.add(diff(t, "REGIME", "regime", a.get("regime"), b.get("regime")));
            divergentTimes.add(t);
        }

        // SIGNAL stage
        for (String f : List.of("confirmedBias", "winnerStrategy", "entryAllowed", "blockReason")) {
            if (strDiverges(a.get(f), b.get(f))) {
                out.add(diff(t, "SIGNAL", f, a.get(f), b.get(f)));
                divergentTimes.add(t);
            }
        }
        if (numericDiverges(a.get("winnerScore"), b.get("winnerScore"), SCORE_TOL)) {
            out.add(diff(t, "SIGNAL", "winnerScore", a.get("winnerScore"), b.get("winnerScore")));
            divergentTimes.add(t);
        }

        // EXECUTION stage
        for (String f : List.of("positionState", "action", "selectedToken", "selectedTradingSymbol")) {
            if (strDiverges(a.get(f), b.get(f))) {
                out.add(diff(t, "EXECUTION", f, a.get(f), b.get(f)));
                divergentTimes.add(t);
            }
        }
        if (numericDiverges(a.get("entryPrice"), b.get("entryPrice"), PRICE_TOL)) {
            out.add(diff(t, "EXECUTION", "entryPrice", a.get("entryPrice"), b.get("entryPrice")));
            divergentTimes.add(t);
        }
    }

    // ── Trade comparator ──────────────────────────────────────────────────────

    private List<TradeMatch> compareTrades(List<Map<String, Object>> tradesA,
                                            List<Map<String, Object>> tradesB) {
        List<TradeMatch> result = new ArrayList<>();
        boolean[] usedB = new boolean[tradesB.size()];

        for (Map<String, Object> ta : tradesA) {
            long taMs    = parseTimeMs(ta.get("entryTime"));
            int  bestIdx = -1;
            long bestDelta = Long.MAX_VALUE;

            for (int i = 0; i < tradesB.size(); i++) {
                if (usedB[i]) continue;
                long delta = Math.abs(parseTimeMs(tradesB.get(i).get("entryTime")) - taMs);
                if (delta < bestDelta && delta <= TRADE_TOL_MS) {
                    bestDelta = delta;
                    bestIdx   = i;
                }
            }

            if (bestIdx < 0) {
                result.add(TradeMatch.builder()
                        .aEntryTime(str(ta.get("entryTime")))
                        .side(str(ta.get("optionType")))
                        .status("A_ONLY")
                        .build());
            } else {
                usedB[bestIdx] = true;
                Map<String, Object> tb = tradesB.get(bestIdx);
                double epA = num(ta.get("entryPrice")), epB = num(tb.get("entryPrice"));
                double xpA = num(ta.get("exitPrice")),  xpB = num(tb.get("exitPrice"));
                double pnlA = num(ta.get("pnl")),       pnlB = num(tb.get("pnl"));
                result.add(TradeMatch.builder()
                        .aEntryTime(str(ta.get("entryTime")))
                        .bEntryTime(str(tb.get("entryTime")))
                        .side(str(ta.get("optionType")))
                        .entryPriceMismatch(Math.abs(epA - epB) > PRICE_TOL)
                        .exitPriceMismatch(Math.abs(xpA - xpB) > PRICE_TOL)
                        .exitReasonMismatch(!Objects.equals(ta.get("exitReason"), tb.get("exitReason")))
                        .pnlDiff(pnlB - pnlA)
                        .status("MATCHED")
                        .build());
            }
        }

        // B-only trades
        for (int i = 0; i < tradesB.size(); i++) {
            if (!usedB[i]) {
                Map<String, Object> tb = tradesB.get(i);
                result.add(TradeMatch.builder()
                        .bEntryTime(str(tb.get("entryTime")))
                        .side(str(tb.get("optionType")))
                        .status("B_ONLY")
                        .build());
            }
        }
        return result;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private List<Map<String, Object>> parseArray(String json) {
        if (json == null || json.isBlank()) return List.of();
        try {
            return objectMapper.readValue(json,
                    new TypeReference<List<Map<String, Object>>>() {});
        } catch (Exception e) {
            log.warn("SessionDivergenceAnalyzer: failed to parse array: {}", e.getMessage());
            return List.of();
        }
    }

    private LinkedHashMap<String, Map<String, Object>> indexBy(
            List<Map<String, Object>> list, String key) {
        LinkedHashMap<String, Map<String, Object>> map = new LinkedHashMap<>();
        for (Map<String, Object> item : list) {
            Object k = item.get(key);
            if (k != null) map.putIfAbsent(k.toString(), item);
        }
        return map;
    }

    private FieldDiff diff(String t, String stage, String field, Object a, Object b) {
        return FieldDiff.builder()
                .niftyTime(t).stage(stage).field(field)
                .aValue(a).bValue(b)
                .build();
    }

    private boolean strDiverges(Object a, Object b) {
        if (a == null && b == null) return false;
        if (a == null || b == null) return true;
        return !a.toString().equals(b.toString());
    }

    private boolean numericDiverges(Object a, Object b, double tol) {
        if (a == null && b == null) return false;
        if (a == null || b == null) return true;
        try {
            return Math.abs(Double.parseDouble(a.toString()) - Double.parseDouble(b.toString())) > tol;
        } catch (NumberFormatException e) {
            return !a.toString().equals(b.toString());
        }
    }

    private long parseTimeMs(Object timeVal) {
        if (timeVal == null) return 0L;
        String s = timeVal.toString();
        try { return Long.parseLong(s); } catch (NumberFormatException ignored) {}
        try {
            return LocalDateTime.parse(s).atZone(IST).toInstant().toEpochMilli();
        } catch (Exception ignored) {}
        return 0L;
    }

    private double num(Object o) {
        if (o == null) return 0.0;
        try { return Double.parseDouble(o.toString()); } catch (Exception e) { return 0.0; }
    }

    private String str(Object o) {
        return o != null ? o.toString() : null;
    }
}
