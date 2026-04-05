package com.sma.dataengine.service;

import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.request.LiveCandleIngestRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
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

        int totalPersisted = 0;
        for (Map.Entry<String, List<CandleData>> entry : groups.entrySet()) {
            List<CandleData> group = entry.getValue();
            try {
                historicalDataService.persistCandles(group, request.getProvider(), "LIVE_RECORDED");
                totalPersisted += group.size();
            } catch (DataIntegrityViolationException e) {
                log.warn("LiveCandleIngest: concurrent insert for runId={} group={}: {}",
                        request.getRunId(), entry.getKey(), e.getMessage());
            } catch (Exception e) {
                log.error("LiveCandleIngest: failed to persist group={} runId={}: {}",
                        entry.getKey(), request.getRunId(), e.getMessage(), e);
            }
        }

        log.debug("LiveCandleIngest: runId={} provider={} persisted={}/{}",
                request.getRunId(), request.getProvider(), totalPersisted, candles.size());
        return totalPersisted;
    }
}
