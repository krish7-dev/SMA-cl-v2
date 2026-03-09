package com.sma.dataengine.controller;

import com.sma.dataengine.adapter.kite.KiteMarketDataAdapter;
import com.sma.dataengine.client.BrokerEngineClient;
import com.sma.dataengine.model.InstrumentInfo;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Instrument search endpoint — searches Kite's instrument list by name/symbol.
 *
 * GET /api/v1/data/instruments/search?q=RELI&exchange=NSE&userId=...&brokerName=kite
 *
 * Caches the full instrument list per exchange for 6 hours.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/data/instruments")
@RequiredArgsConstructor
public class InstrumentController {

    private final KiteMarketDataAdapter adapter;
    private final BrokerEngineClient    brokerEngineClient;

    private record CacheEntry(Instant fetchedAt, List<InstrumentInfo> instruments) {}
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();
    private static final long CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

    @GetMapping("/search")
    public ResponseEntity<?> search(
            @RequestParam(required = false, defaultValue = "") String q,
            @RequestParam(required = false, defaultValue = "NSE") String exchange,
            @RequestParam(required = false, defaultValue = "") String type,
            @RequestParam String userId,
            @RequestParam(required = false, defaultValue = "kite") String brokerName) {

        BrokerEngineClient.Credentials creds = brokerEngineClient.fetchCredentials(userId, brokerName);
        if (!creds.isComplete()) {
            return ResponseEntity.status(401)
                    .body(Map.of("message", "No valid session — activate a broker account first"));
        }

        try {
            List<InstrumentInfo> results = searchWithCache(creds.apiKey(), creds.accessToken(), exchange, q, type);
            return ResponseEntity.ok(Map.of("data", results));
        } catch (Exception e) {
            log.error("Instrument search failed: {}", e.getMessage());
            return ResponseEntity.status(502).body(Map.of("message", e.getMessage()));
        }
    }

    /** Exchanges searched when exchange=ALL. NSE + NFO covers equities and F&O. */
    private static final List<String> ALL_EXCHANGES = List.of("NSE", "NFO", "BSE", "BFO", "MCX", "CDS");

    private List<InstrumentInfo> searchWithCache(String apiKey, String accessToken,
                                                  String exchange, String query, String type) {
        String cacheKey = exchange.toUpperCase().trim();

        if (cacheKey.equals("ALL") || cacheKey.isEmpty()) {
            // Search across all already-cached exchanges — no new fetches on ALL
            String q = query == null ? "" : query.toLowerCase().trim();
            String t = type  == null ? "" : type.toUpperCase().trim();
            List<InstrumentInfo> merged = new ArrayList<>();
            for (String ex : ALL_EXCHANGES) {
                CacheEntry e = cache.get(ex);
                if (e == null) continue;
                e.instruments().stream()
                        .filter(i -> t.isEmpty() || t.equals(i.getInstrumentType()))
                        .filter(i -> q.isEmpty()
                                || i.getTradingSymbol().toLowerCase().contains(q)
                                || (i.getName() != null && i.getName().toLowerCase().contains(q)))
                        .limit(25 - merged.size())
                        .forEach(merged::add);
                if (merged.size() >= 25) break;
            }
            return merged;
        }

        // Single-exchange path
        CacheEntry entry = cache.get(cacheKey);
        boolean expired = entry == null ||
                Instant.now().getEpochSecond() - entry.fetchedAt().getEpochSecond() > CACHE_TTL_SECONDS;

        if (expired) {
            log.info("Fetching full instrument list from Kite for exchange={}", cacheKey);
            List<InstrumentInfo> all = adapter.fetchAllInstruments(apiKey, accessToken, exchange);
            entry = new CacheEntry(Instant.now(), all);
            cache.put(cacheKey, entry);
            log.info("Cached {} instruments for exchange={}", all.size(), cacheKey);
        }

        String q = query == null ? "" : query.toLowerCase().trim();
        String t = type  == null ? "" : type.toUpperCase().trim();

        return entry.instruments().stream()
                .filter(i -> t.isEmpty() || t.equals(i.getInstrumentType()))
                .filter(i -> q.isEmpty()
                        || i.getTradingSymbol().toLowerCase().contains(q)
                        || (i.getName() != null && i.getName().toLowerCase().contains(q)))
                .limit(25)
                .toList();
    }
}
