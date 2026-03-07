package com.sma.dataengine.service;

import com.sma.dataengine.adapter.MarketDataAdapter;
import com.sma.dataengine.adapter.MarketDataAdapterRegistry;
import com.sma.dataengine.entity.CandleRecord;
import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.Interval;
import com.sma.dataengine.model.request.HistoricalDataRequest;
import com.sma.dataengine.repository.CandleRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * Fetches and persists historical OHLCV candle data.
 *
 * Flow:
 * 1. Check candle_data table for an existing cache hit (optional optimization).
 * 2. If not found or cache is stale, delegate to the broker adapter's REST API.
 * 3. Persist fetched candles when request.isPersist() == true.
 * 4. Return normalized CandleData list — oldest first.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class HistoricalDataService {

    private final MarketDataAdapterRegistry adapterRegistry;
    private final CandleRepository          candleRepository;

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Fetches historical candles, optionally persisting them for replay.
     *
     * @return List of normalized CandleData, oldest first
     */
    @Transactional
    public List<CandleData> getHistoricalData(HistoricalDataRequest request) {
        // Check DB cache first
        boolean cached = candleRepository.existsInRange(
                request.getInstrumentToken(),
                request.getInterval().getKiteValue(),
                request.getBrokerName(),
                request.getFromDate(),
                request.getToDate()
        );

        if (cached) {
            log.info("Serving historical data from DB cache: token={}, interval={}, from={}, to={}",
                    request.getInstrumentToken(), request.getInterval(), request.getFromDate(), request.getToDate());
            return loadFromDb(request);
        }

        // Cache miss — fetch from broker adapter
        log.info("Cache miss — fetching from broker adapter: token={}, provider={}",
                request.getInstrumentToken(), request.getBrokerName());

        MarketDataAdapter adapter = adapterRegistry.resolve(request.getBrokerName());
        List<CandleData> candles = adapter.getHistoricalData(request);

        if (request.isPersist() && !candles.isEmpty()) {
            persistCandles(candles, request.getBrokerName());
        }

        return candles;
    }

    /**
     * Loads candles from DB for replay — always reads from persistence, never the broker.
     * Call this from ReplayService so replay is not subject to API rate limits.
     */
    @Transactional(readOnly = true)
    public List<CandleData> loadFromDbForReplay(HistoricalDataRequest request) {
        return loadFromDb(request);
    }

    // ─── Private Helpers ──────────────────────────────────────────────────────

    private List<CandleData> loadFromDb(HistoricalDataRequest request) {
        List<CandleRecord> records = candleRepository
                .findByInstrumentTokenAndIntervalAndProviderAndOpenTimeBetweenOrderByOpenTimeAsc(
                        request.getInstrumentToken(),
                        request.getInterval().getKiteValue(),
                        request.getBrokerName(),
                        request.getFromDate(),
                        request.getToDate()
                );
        return records.stream().map(this::toCandle).toList();
    }

    @Transactional
    public void persistCandles(List<CandleData> candles, String provider) {
        List<CandleRecord> records = candles.stream()
                .map(c -> toRecord(c, provider))
                .toList();

        // saveAll with ignore-on-duplicate via DB unique constraint
        try {
            candleRepository.saveAll(records);
            log.info("Persisted {} candles (provider={})", records.size(), provider);
        } catch (Exception e) {
            // Duplicate key on upsert is acceptable — log and continue
            log.warn("Some candles skipped (duplicate): {}", e.getMessage());
        }
    }

    private CandleRecord toRecord(CandleData c, String provider) {
        return CandleRecord.builder()
                .instrumentToken(c.getInstrumentToken())
                .symbol(c.getSymbol())
                .exchange(c.getExchange())
                .interval(c.getInterval().getKiteValue())
                .openTime(c.getOpenTime())
                .open(c.getOpen())
                .high(c.getHigh())
                .low(c.getLow())
                .close(c.getClose())
                .volume(c.getVolume() != null ? c.getVolume() : 0L)
                .openInterest(c.getOpenInterest() != null ? c.getOpenInterest() : 0L)
                .provider(provider)
                .fetchedAt(Instant.now())
                .build();
    }

    private CandleData toCandle(CandleRecord r) {
        return CandleData.builder()
                .instrumentToken(r.getInstrumentToken())
                .symbol(r.getSymbol())
                .exchange(r.getExchange())
                .interval(Interval.fromKiteValue(r.getInterval()))
                .openTime(r.getOpenTime())
                .open(r.getOpen())
                .high(r.getHigh())
                .low(r.getLow())
                .close(r.getClose())
                .volume(r.getVolume())
                .openInterest(r.getOpenInterest())
                .provider(r.getProvider())
                .build();
    }
}
