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
 * Compares two saved session feeds (live vs replay) to pinpoint the first
 * divergence — candle OHLCV, regime, signal, or execution layer.
 *
 * <p>Uses {@code niftyTime} as the join key. Both feeds must have been saved
 * after Fix-1 (niftyTime = bucket-start, not actual tick time) for the key
 * to match reliably.
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
        private Object liveValue;
        private Object replayValue;
    }

    @Data @Builder
    public static class TradeMatch {
        private String  liveEntryTime;
        private String  replayEntryTime;
        /** CE or PE */
        private String  side;
        private boolean entryPriceMismatch;   // |live − replay| > PRICE_TOL
        private boolean exitPriceMismatch;
        private boolean exitReasonMismatch;
        private double  pnlDiff;              // replay.pnl − live.pnl
        /** MATCHED | LIVE_ONLY | REPLAY_ONLY */
        private String  status;
    }

    @Data @Builder
    public static class DivergenceReport {
        private String sessionA;              // typically LIVE
        private String sessionB;              // typically TICK_REPLAY
        private int    matchedCandles;
        private int    liveOnlyCount;
        private int    replayOnlyCount;
        private int    divergentCandleCount;
        /** niftyTime of first candle that differs in any stage. */
        private String firstDivergenceTime;
        /** Stage of first difference: CANDLE | REGIME | SIGNAL | EXECUTION */
        private String firstDivergenceStage;
        private List<FieldDiff>  divergences;
        private List<String>     liveOnlyTimes;
        private List<String>     replayOnlyTimes;
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

        List<String>    liveOnly    = new ArrayList<>();
        List<String>    replayOnly  = new ArrayList<>();
        List<FieldDiff> divergences = new ArrayList<>();
        Set<String>     divergentTimes = new LinkedHashSet<>();

        for (String t : allTimes) {
            boolean inA = mapA.containsKey(t);
            boolean inB = mapB.containsKey(t);
            if (!inA) { replayOnly.add(t); continue; }
            if (!inB) { liveOnly.add(t);   continue; }
            compareCandle(t, mapA.get(t), mapB.get(t), divergences, divergentTimes);
        }

        // First divergence across all stages
        String firstTime  = null;
        String firstStage = null;
        if (!divergences.isEmpty()) {
            firstTime  = divergences.get(0).getNiftyTime();
            firstStage = divergences.get(0).getStage();
        }

        int matched = (int) allTimes.stream()
                .filter(t -> mapA.containsKey(t) && mapB.containsKey(t))
                .count();

        List<TradeMatch> trades = compareTrades(
                parseArray(recA.getClosedTradesJson()),
                parseArray(recB.getClosedTradesJson()));

        log.info("Divergence analysis {}/{}: matched={} liveOnly={} replayOnly={} "
                + "divergentBuckets={} firstAt={} firstStage={}",
                sessionA, sessionB, matched,
                liveOnly.size(), replayOnly.size(), divergentTimes.size(),
                firstTime, firstStage);

        return DivergenceReport.builder()
                .sessionA(sessionA)
                .sessionB(sessionB)
                .matchedCandles(matched)
                .liveOnlyCount(liveOnly.size())
                .replayOnlyCount(replayOnly.size())
                .divergentCandleCount(divergentTimes.size())
                .firstDivergenceTime(firstTime)
                .firstDivergenceStage(firstStage)
                .divergences(divergences)
                .liveOnlyTimes(liveOnly)
                .replayOnlyTimes(replayOnly)
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
                        .liveEntryTime(str(ta.get("entryTime")))
                        .side(str(ta.get("optionType")))
                        .status("LIVE_ONLY")
                        .build());
            } else {
                usedB[bestIdx] = true;
                Map<String, Object> tb = tradesB.get(bestIdx);
                double epA = num(ta.get("entryPrice")), epB = num(tb.get("entryPrice"));
                double xpA = num(ta.get("exitPrice")),  xpB = num(tb.get("exitPrice"));
                double pnlA = num(ta.get("pnl")),       pnlB = num(tb.get("pnl"));
                result.add(TradeMatch.builder()
                        .liveEntryTime(str(ta.get("entryTime")))
                        .replayEntryTime(str(tb.get("entryTime")))
                        .side(str(ta.get("optionType")))
                        .entryPriceMismatch(Math.abs(epA - epB) > PRICE_TOL)
                        .exitPriceMismatch(Math.abs(xpA - xpB) > PRICE_TOL)
                        .exitReasonMismatch(!Objects.equals(ta.get("exitReason"), tb.get("exitReason")))
                        .pnlDiff(pnlB - pnlA)
                        .status("MATCHED")
                        .build());
            }
        }

        // replay-only trades
        for (int i = 0; i < tradesB.size(); i++) {
            if (!usedB[i]) {
                Map<String, Object> tb = tradesB.get(i);
                result.add(TradeMatch.builder()
                        .replayEntryTime(str(tb.get("entryTime")))
                        .side(str(tb.get("optionType")))
                        .status("REPLAY_ONLY")
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
                .liveValue(a).replayValue(b)
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
