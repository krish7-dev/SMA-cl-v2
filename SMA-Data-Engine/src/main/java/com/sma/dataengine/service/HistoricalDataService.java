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
import org.springframework.stereotype.Service;
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
        if (candles.isEmpty()) return;

        // Drop candles whose timestamp could not be parsed (null openTime)
        List<CandleRecord> records = candles.stream()
                .map(c -> toRecord(c, provider))
                .filter(r -> r.getOpenTime() != null)
                .toList();

        if (records.isEmpty()) {
            log.warn("No valid candles to persist after filtering null timestamps (provider={})", provider);
            return;
        }

        // Pre-filter records that already exist — avoids unique-constraint violations
        // which would poison the active PostgreSQL transaction even if caught.
        LocalDateTime minTime = records.stream().map(CandleRecord::getOpenTime).min(LocalDateTime::compareTo).orElse(null);
        LocalDateTime maxTime = records.stream().map(CandleRecord::getOpenTime).max(LocalDateTime::compareTo).orElse(null);
        Long token    = records.get(0).getInstrumentToken();
        String interval = records.get(0).getInterval();

        Set<LocalDateTime> existing = new HashSet<>(
                candleRepository.findOpenTimesInRange(token, interval, provider, minTime, maxTime));

        List<CandleRecord> newRecords = records.stream()
                .filter(r -> !existing.contains(r.getOpenTime()))
                .toList();

        if (newRecords.isEmpty()) {
            log.info("All {} candles already cached (provider={})", records.size(), provider);
            return;
        }

        candleRepository.saveAll(newRecords);
        log.info("Persisted {}/{} candles (provider={}, {} already cached)",
                newRecords.size(), records.size(), provider, existing.size());
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

    private static boolean isMissing(String value) {
        return value == null || value.isBlank();
    }
}
