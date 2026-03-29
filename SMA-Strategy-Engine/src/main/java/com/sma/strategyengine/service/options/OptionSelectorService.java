package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import lombok.extern.slf4j.Slf4j;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

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

    // optionCandleMap: token -> (openTime -> CandleDto)
    private final Map<Long, Map<LocalDateTime, CandleDto>> optionCandleMap;

    public OptionSelectorService(OptionsReplayRequest.SelectionConfig selConfig,
                                 Map<Long, Map<LocalDateTime, CandleDto>> optionCandleMap) {
        this.selConfig      = selConfig;
        this.optionCandleMap = optionCandleMap;
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

        // Step 2: Premium too high -> prefer candidates with premium closer to maxPremium (OTM shift)
        boolean allTooHigh  = priced.stream().allMatch(p -> p.premium() > selConfig.getMaxPremium());
        boolean allTooLow   = priced.stream().allMatch(p -> p.premium() < selConfig.getMinPremium());

        if (allTooHigh) {
            // OTM shift: pick lowest premium (most OTM) still usable
            return priced.stream()
                    .min(java.util.Comparator.comparingDouble(Priced::premium))
                    .map(Priced::cand).orElse(null);
        }
        if (allTooLow) {
            // ITM shift: pick highest premium (most ITM) still usable
            return priced.stream()
                    .max(java.util.Comparator.comparingDouble(Priced::premium))
                    .map(Priced::cand).orElse(null);
        }

        // Mixed: pick nearest ATM overall
        return priced.stream()
                .min(java.util.Comparator.comparingDouble(p ->
                        Math.abs(p.cand().getStrike() - niftyPrice)))
                .map(Priced::cand).orElse(null);
    }

    /** Get current option candle close price as premium. Returns 0 if not available. */
    public double getPremium(Long token, LocalDateTime time) {
        if (token == null || time == null) return 0;
        Map<LocalDateTime, CandleDto> tokenCandles = optionCandleMap.get(token);
        if (tokenCandles == null) return 0;
        CandleDto c = tokenCandles.get(time);
        if (c == null || c.close() == null) return 0;
        return c.close().doubleValue();
    }

    /** Get a full candle for an option token at a given time. */
    public CandleDto getCandle(Long token, LocalDateTime time) {
        if (token == null || time == null) return null;
        Map<LocalDateTime, CandleDto> tokenCandles = optionCandleMap.get(token);
        if (tokenCandles == null) return null;
        return tokenCandles.get(time);
    }
}
