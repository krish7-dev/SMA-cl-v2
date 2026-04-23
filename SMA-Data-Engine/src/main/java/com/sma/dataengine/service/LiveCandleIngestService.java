package com.sma.dataengine.service;

import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.request.LiveCandleIngestRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Persists live-recorded candles arriving from Strategy Engine's live options sessions.
 *
 * <p>Each request carries a batch of fully-formed OHLCV candles (NIFTY + option tokens)
 * that closed during a live session. Candles are routed to
 * {@link HistoricalDataService#persistCandles} using sourceType={@code LIVE_RECORDED},
 * so they coexist with HISTORICAL_API candles in the same table and can be
 * used as higher-fidelity data for later replay.
 *
 * <p>Grouping: candles in a batch may span multiple tokens and intervals.
 * They are grouped by (instrumentToken + interval) before persisting to satisfy
 * the dedup pre-filter in {@code persistCandles}.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class LiveCandleIngestService {

    private final HistoricalDataService historicalDataService;
    private final AsyncCandleWriter     asyncCandleWriter;

    /**
     * Persists a batch of live-recorded candles.
     * Candles with a null interval are resolved from the CandleData.interval field.
     *
     * @throws IllegalArgumentException if sourceType is not "LIVE_RECORDED"
     */
    public int ingest(LiveCandleIngestRequest request) {
        if (!"LIVE_RECORDED".equals(request.getSourceType())) {
            throw new IllegalArgumentException(
                    "LiveCandleIngestService only accepts sourceType=LIVE_RECORDED, got: " +
                    request.getSourceType());
        }

        List<CandleData> candles = request.getCandles();
        if (candles == null || candles.isEmpty()) return 0;

        // Group by (instrumentToken, interval) — persistCandles operates on a single token/interval batch
        Map<String, List<CandleData>> groups = candles.stream()
                .filter(c -> c.getInstrumentToken() != null && c.getInterval() != null && c.getOpenTime() != null)
                .collect(Collectors.groupingBy(
                        c -> c.getInstrumentToken() + "::" + c.getInterval().getKiteValue()));

        int totalSubmitted = 0;
        for (Map.Entry<String, List<CandleData>> entry : groups.entrySet()) {
            List<CandleData> group = entry.getValue();
            String groupKey = entry.getKey();
            String runId    = request.getRunId();
            String provider = request.getProvider();
            asyncCandleWriter.submit(() -> {
                try {
                    historicalDataService.persistCandles(group, provider, "LIVE_RECORDED");
                } catch (Exception e) {
                    // Re-throw so AsyncCandleWriter retries — it will keep retrying until success
                    throw new RuntimeException("LiveCandleIngest failed for group=" + groupKey +
                            " runId=" + runId + ": " + e.getMessage(), e);
                }
            });
            totalSubmitted += group.size();
        }

        log.debug("LiveCandleIngest: runId={} provider={} submitted={}/{} to async writer (queue depth={})",
                request.getRunId(), request.getProvider(), totalSubmitted, candles.size(),
                asyncCandleWriter.queueDepth());
        return totalSubmitted;
    }
}
