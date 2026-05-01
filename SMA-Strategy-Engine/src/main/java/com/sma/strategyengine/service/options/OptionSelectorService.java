package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import lombok.extern.slf4j.Slf4j;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;
import java.util.TreeMap;

/**
 * Selects the best option instrument from a candidate pool based on current premium
 * and strike proximity.
 *
 * Priority:
 *   1. Nearest ATM within premium band [minPremium, maxPremium]
 *   2. If premium too high  -> shift slightly OTM (lower premium)
 *   3. If premium too low   -> shift slightly ITM (higher premium)
 *   4. Fallback: absolute nearest ATM ignoring premium constraint
 */
@Slf4j
public class OptionSelectorService {

    private final OptionsReplayRequest.SelectionConfig selConfig;

    // optionCandleMap: token -> (openTime -> CandleDto), sorted for forward-fill lookups
    private final Map<Long, NavigableMap<LocalDateTime, CandleDto>> optionCandleMap;

    /** Replay mode: wraps each token's flat map in a TreeMap for sorted forward-fill lookups. */
    public static OptionSelectorService forReplay(OptionsReplayRequest.SelectionConfig selConfig,
                                                  Map<Long, Map<LocalDateTime, CandleDto>> optionCandleMap) {
        Map<Long, NavigableMap<LocalDateTime, CandleDto>> sorted = new java.util.HashMap<>();
        optionCandleMap.forEach((token, byTime) -> sorted.put(token, new TreeMap<>(byTime)));
        return new OptionSelectorService(selConfig, sorted);
    }

    /** Live mode: uses the pre-sorted map by reference so new candles are immediately visible. */
    public static OptionSelectorService forLive(OptionsReplayRequest.SelectionConfig selConfig,
                                                Map<Long, NavigableMap<LocalDateTime, CandleDto>> liveSortedMap) {
        return new OptionSelectorService(selConfig, liveSortedMap);
    }

    private OptionSelectorService(OptionsReplayRequest.SelectionConfig selConfig,
                                  Map<Long, NavigableMap<LocalDateTime, CandleDto>> sortedMap) {
        this.selConfig = selConfig;
        this.optionCandleMap = sortedMap;
    }

    /**
     * Select the best option instrument from the given pool at the specified candle time.
     *
     * @param pool         list of CE or PE candidates
     * @param niftyPrice   current NIFTY close
     * @param candleTime   current replay candle time (used to look up option candle)
     * @return selected candidate, or null if no data available
     */
    public OptionsReplayRequest.OptionCandidate select(
            List<OptionsReplayRequest.OptionCandidate> pool,
            double niftyPrice,
            LocalDateTime candleTime) {

        if (pool == null || pool.isEmpty()) return null;

        // Get current premium for each candidate
        record Priced(OptionsReplayRequest.OptionCandidate cand, double premium) {}

        List<Priced> priced = pool.stream()
                .map(c -> {
                    double prem = getPremium(c.getInstrumentToken(), candleTime);
                    return new Priced(c, prem);
                })
                .filter(p -> p.premium() > 0)
                .toList();

        if (priced.isEmpty()) {
            if (selConfig.isStrictPremiumBand()) {
                log.debug("[SELECTOR] strictPremiumBand: no priced candidates — skipping entry");
                return null;
            }
            // Fallback: nearest ATM by strike distance
            return pool.stream()
                    .min(java.util.Comparator.comparingDouble(c ->
                            Math.abs(c.getStrike() - niftyPrice)))
                    .orElse(null);
        }

        // Step 1: Filter within premium band, then pick nearest ATM
        Optional<Priced> inBand = priced.stream()
                .filter(p -> p.premium() >= selConfig.getMinPremium()
                        && p.premium() <= selConfig.getMaxPremium())
                .min(java.util.Comparator.comparingDouble(p ->
                        Math.abs(p.cand().getStrike() - niftyPrice)));

        if (inBand.isPresent()) return inBand.get().cand();

        // No in-band candidate found — strict mode blocks entry
        if (selConfig.isStrictPremiumBand()) {
            double minP = priced.stream().mapToDouble(Priced::premium).min().orElse(0);
            double maxP = priced.stream().mapToDouble(Priced::premium).max().orElse(0);
            log.debug("[SELECTOR] strictPremiumBand: no candidate in [{},{}] — pool range [{},{}] — skipping entry",
                    selConfig.getMinPremium(), selConfig.getMaxPremium(),
                    String.format("%.1f", minP), String.format("%.1f", maxP));
            return null;
        }

        // Step 2: Premium too high -> prefer candidates with premium closer to maxPremium (OTM shift)
        boolean allTooHigh  = priced.stream().allMatch(p -> p.premium() > selConfig.getMaxPremium());
        boolean allTooLow   = priced.stream().allMatch(p -> p.premium() < selConfig.getMinPremium());

        if (allTooHigh) {
            // OTM shift: pick lowest premium (most OTM) still usable
            log.debug("[SELECTOR] allTooHigh fallback: all premiums above maxPremium={}", selConfig.getMaxPremium());
            return priced.stream()
                    .min(java.util.Comparator.comparingDouble(Priced::premium))
                    .map(Priced::cand).orElse(null);
        }
        if (allTooLow) {
            // ITM shift: pick highest premium (most ITM) still usable
            log.debug("[SELECTOR] allTooLow fallback: all premiums below minPremium={}", selConfig.getMinPremium());
            return priced.stream()
                    .max(java.util.Comparator.comparingDouble(Priced::premium))
                    .map(Priced::cand).orElse(null);
        }

        // Mixed: pick nearest ATM overall
        log.debug("[SELECTOR] mixed fallback: no candidate in band, picking nearest ATM");
        return priced.stream()
                .min(java.util.Comparator.comparingDouble(p ->
                        Math.abs(p.cand().getStrike() - niftyPrice)))
                .map(Priced::cand).orElse(null);
    }

    /**
     * Get current option candle close price as premium.
     * If no candle exists at the exact time, forward-fills from the most recent prior candle
     * (handles illiquid options with gaps at market open).
     * Returns 0 only if no prior candle exists at all.
     */
    public double getPremium(Long token, LocalDateTime time) {
        CandleDto c = getCandle(token, time);
        if (c == null || c.close() == null) return 0;
        return c.close().doubleValue();
    }

    /**
     * Get a full candle for an option token at a given time.
     * Forward-fills from the most recent prior candle when exact match is absent.
     */
    public CandleDto getCandle(Long token, LocalDateTime time) {
        if (token == null || time == null) return null;
        NavigableMap<LocalDateTime, CandleDto> tokenCandles = optionCandleMap.get(token);
        if (tokenCandles == null || tokenCandles.isEmpty()) return null;
        // Exact match first
        CandleDto exact = tokenCandles.get(time);
        if (exact != null) return exact;
        // Forward-fill: use the most recent candle at or before this time
        Map.Entry<LocalDateTime, CandleDto> prior = tokenCandles.floorEntry(time);
        if (prior != null) {
            log.debug("Option price forward-fill: token={} requested={} using={} close={}",
                    token, time, prior.getKey(),
                    prior.getValue().close() != null ? prior.getValue().close() : "null");
            return prior.getValue();
        }
        return null;
    }
}
