package com.sma.dataengine.service;

import com.sma.dataengine.adapter.MarketDataAdapter;
import com.sma.dataengine.adapter.MarketDataAdapterRegistry;
import com.sma.dataengine.client.BrokerEngineClient;
import com.sma.dataengine.entity.CandleRecord;
import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.Interval;
import com.sma.dataengine.model.request.HistoricalDataRequest;
import com.sma.dataengine.repository.CandleRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDateTime;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Fetches and persists historical OHLCV candle data.
 *
 * Flow:
 * 1. Auto-resolve apiKey + accessToken from Broker Engine when not provided.
 * 2. Check candle_data table for an existing cache hit.
 * 3. If not found, delegate to the broker adapter's REST API.
 * 4. Persist fetched candles when request.isPersist() == true.
 * 5. Return normalized CandleData list — oldest first.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class HistoricalDataService {

    private final MarketDataAdapterRegistry adapterRegistry;
    private final CandleRepository          candleRepository;
    private final BrokerEngineClient        brokerEngineClient;

    // Self-injection to route persistCandles() through the Spring proxy so that
    // REQUIRES_NEW creates a real nested transaction (self-invocation bypasses AOP).
    @Lazy
    @Autowired
    private HistoricalDataService self;

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Fetches historical candles, optionally persisting them for replay.
     *
     * @return List of normalized CandleData, oldest first
     */
    @Transactional
    public List<CandleData> getHistoricalData(HistoricalDataRequest request) {
        // Auto-resolve credentials from Broker Engine when not provided by the caller
        if (isMissing(request.getApiKey()) || isMissing(request.getAccessToken())) {
            BrokerEngineClient.Credentials creds =
                    brokerEngineClient.fetchCredentials(request.getUserId(), request.getBrokerName());
            if (creds.isComplete()) {
                request.setApiKey(creds.apiKey());
                request.setAccessToken(creds.accessToken());
                log.info("Auto-resolved credentials from Broker Engine for userId={}, broker={}",
                        request.getUserId(), request.getBrokerName());
            } else {
                throw new IllegalStateException(
                        "No apiKey/accessToken in request and Broker Engine could not supply them. " +
                        "Activate a session in the UI or ensure the broker account is ACTIVE. " +
                        "userId=" + request.getUserId() + ", broker=" + request.getBrokerName());
            }
        }

        // Always fetch from broker adapter to ensure the full requested range is covered.
        // The adapter chunks requests internally (e.g. Kite limits intraday to 60 days per call).
        log.info("Fetching historical data: token={}, interval={}, from={}, to={}, persist={}",
                request.getInstrumentToken(), request.getInterval(),
                request.getFromDate(), request.getToDate(), request.isPersist());

        MarketDataAdapter adapter = adapterRegistry.resolve(request.getBrokerName());
        List<CandleData> candles = adapter.getHistoricalData(request);

        if (request.isPersist() && !candles.isEmpty()) {
            // Merge new candles into DB (dedup prevents duplicate inserts).
            // Runs in REQUIRES_NEW so a concurrent duplicate-key violation rolls back
            // only the inner transaction and does not poison this one.
            try {
                self.persistCandles(candles, request.getBrokerName(), "HISTORICAL_API");
            } catch (DataIntegrityViolationException e) {
                log.warn("Concurrent candle insert detected — candles already persisted by another request " +
                         "(provider={}, token={}): {}", request.getBrokerName(),
                         request.getInstrumentToken(), e.getMessage());
            }
            // Load from DB afterwards to include any previously cached candles.
            return loadFromDb(request);
        }

        // persist=false (e.g. backtest): return fetched candles directly, skip DB round-trip
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

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void persistCandles(List<CandleData> candles, String provider, String sourceType) {
        if (candles.isEmpty()) return;

        // Drop candles whose timestamp could not be parsed (null openTime)
        List<CandleRecord> records = candles.stream()
                .map(c -> toRecord(c, provider, sourceType))
                .filter(r -> r.getOpenTime() != null)
                .toList();

        if (records.isEmpty()) {
            log.warn("No valid candles to persist after filtering null timestamps (provider={}, sourceType={})",
                    provider, sourceType);
            return;
        }

        // Pre-filter records that already exist for this (token, interval, provider, sourceType) —
        // avoids unique-constraint violations which poison the active PostgreSQL transaction.
        LocalDateTime minTime  = records.stream().map(CandleRecord::getOpenTime).min(LocalDateTime::compareTo).orElse(null);
        LocalDateTime maxTime  = records.stream().map(CandleRecord::getOpenTime).max(LocalDateTime::compareTo).orElse(null);
        Long          token    = records.get(0).getInstrumentToken();
        String        interval = records.get(0).getInterval();

        Set<LocalDateTime> existing = new HashSet<>(
                candleRepository.findOpenTimesInRange(token, interval, provider, sourceType, minTime, maxTime));

        List<CandleRecord> newRecords = records.stream()
                .filter(r -> !existing.contains(r.getOpenTime()))
                .toList();

        if (newRecords.isEmpty()) {
            log.info("All {} candles already cached (provider={}, sourceType={})", records.size(), provider, sourceType);
            return;
        }

        candleRepository.saveAll(newRecords);
        log.info("Persisted {}/{} candles (provider={}, sourceType={}, {} already cached)",
                newRecords.size(), records.size(), provider, sourceType, existing.size());
    }

    private CandleRecord toRecord(CandleData c, String provider, String sourceType) {
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
                .sourceType(sourceType)
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
                .sourceType(r.getSourceType())
                .build();
    }

    private static boolean isMissing(String value) {
        return value == null || value.isBlank();
    }
}
