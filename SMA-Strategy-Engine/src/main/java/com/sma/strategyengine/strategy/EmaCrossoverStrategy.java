package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Exponential Moving Average (EMA) Crossover strategy.
 *
 * Like SMA crossover but gives more weight to recent prices.
 * Reacts faster to price changes than the equivalent SMA strategy.
 *
 * Signal rules:
 *   BUY  — short EMA crosses above long EMA
 *   SELL — short EMA crosses below long EMA
 *   HOLD — no crossover, or still warming up
 *
 * Parameters:
 *   shortPeriod — fast EMA lookback (default: 9)
 *   longPeriod  — slow EMA lookback (default: 21)
 *
 * Warmup: longPeriod candles (slow EMA seeded via SMA, fast EMA seeded via
 *         SMA of last shortPeriod prices within the same window).
 */
@Slf4j
@Component
public class EmaCrossoverStrategy implements StrategyLogic {

    public static final String TYPE = "EMA_CROSSOVER";

    private static class State {
        int count = 0;
        double shortEma     = 0;
        double longEma      = 0;
        double prevShortEma = 0;
        double prevLongEma  = 0;
        List<Double> warmupPrices = new ArrayList<>();
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override
    public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int shortPeriod = ctx.paramInt("shortPeriod", 9);
        int longPeriod  = ctx.paramInt("longPeriod",  21);

        if (shortPeriod >= longPeriod) {
            return StrategyResult.hold("Invalid config: shortPeriod (" + shortPeriod +
                    ") must be less than longPeriod (" + longPeriod + ")");
        }

        double close     = ctx.getCandleClose().doubleValue();
        double shortMult = 2.0 / (shortPeriod + 1);
        double longMult  = 2.0 / (longPeriod  + 1);

        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());
        s.count++;
        if (s.warmupPrices != null) s.warmupPrices.add(close);

        // Collect longPeriod prices to seed both EMAs via SMA
        if (s.count < longPeriod) {
            return StrategyResult.hold(
                    "Warming up: " + s.count + "/" + longPeriod + " candles",
                    Map.of("collectedCandles", s.count, "requiredCandles", longPeriod));
        }

        if (s.count == longPeriod) {
            s.longEma      = average(s.warmupPrices, 0, longPeriod);
            s.shortEma     = average(s.warmupPrices, longPeriod - shortPeriod, shortPeriod);
            s.warmupPrices = null;
            s.prevShortEma = s.shortEma;
            s.prevLongEma  = s.longEma;
            return StrategyResult.hold("EMA seeded — next candle enables crossover detection",
                    Map.of("shortEma", r4(s.shortEma), "longEma", r4(s.longEma)));
        }

        // Live update
        s.prevShortEma = s.shortEma;
        s.prevLongEma  = s.longEma;
        s.shortEma = close * shortMult + s.shortEma * (1 - shortMult);
        s.longEma  = close * longMult  + s.longEma  * (1 - longMult);

        Map<String, Object> meta = Map.of(
                "shortPeriod",  shortPeriod,        "longPeriod",   longPeriod,
                "shortEmaCur",  r4(s.shortEma),     "longEmaCur",   r4(s.longEma),
                "shortEmaPrev", r4(s.prevShortEma), "longEmaPrev",  r4(s.prevLongEma),
                "close",        close
        );

        if (s.prevShortEma <= s.prevLongEma && s.shortEma > s.longEma) {
            log.info("BUY [EMA_CROSSOVER]: instanceId={}, symbol={}, short={}, long={}",
                    ctx.getInstanceId(), ctx.getSymbol(), r4(s.shortEma), r4(s.longEma));
            return StrategyResult.buy(
                    "EMA crossover — short(" + shortPeriod + ")=" + r4(s.shortEma) +
                    " crossed above long(" + longPeriod + ")=" + r4(s.longEma), meta);
        }

        if (s.prevShortEma >= s.prevLongEma && s.shortEma < s.longEma) {
            log.info("SELL [EMA_CROSSOVER]: instanceId={}, symbol={}, short={}, long={}",
                    ctx.getInstanceId(), ctx.getSymbol(), r4(s.shortEma), r4(s.longEma));
            return StrategyResult.sell(
                    "EMA crossunder — short(" + shortPeriod + ")=" + r4(s.shortEma) +
                    " crossed below long(" + longPeriod + ")=" + r4(s.longEma), meta);
        }

        return StrategyResult.hold(
                "No EMA crossover — short=" + r4(s.shortEma) + ", long=" + r4(s.longEma), meta);
    }

    @Override
    public void onInstanceRemoved(String instanceId) {
        states.remove(instanceId);
        log.debug("Cleared EMA state for removed instance: {}", instanceId);
    }

    private static double average(List<Double> list, int from, int count) {
        double sum = 0;
        for (int i = from; i < from + count; i++) sum += list.get(i);
        return sum / count;
    }

    private static double r4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }
}
