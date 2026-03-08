package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Simple Moving Average (SMA) Crossover strategy.
 *
 * Signal rules:
 *   BUY  — short SMA crosses ABOVE long SMA on the current candle
 *   SELL — short SMA crosses BELOW long SMA on the current candle
 *   HOLD — no crossover detected or not enough data yet
 *
 * Configuration parameters (stored in strategy_instance.parameters JSON):
 *   shortPeriod  — lookback for the fast SMA  (default: 5)
 *   longPeriod   — lookback for the slow SMA  (default: 20)
 *
 * State:
 *   Each strategy instance maintains its own sliding price window in memory
 *   keyed by instanceId. The window holds exactly longPeriod + 1 close prices
 *   (one extra to compare current vs. previous bar SMAs for crossover detection).
 *   State is reset on service restart, which is acceptable for a demo strategy.
 */
@Slf4j
@Component
public class SmaCrossoverStrategy implements StrategyLogic {

    public static final String TYPE = "SMA_CROSSOVER";

    /** Per-instance sliding window of recent close prices. Thread-safe map. */
    private final Map<String, ArrayDeque<BigDecimal>> priceWindows = new ConcurrentHashMap<>();

    @Override
    public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int shortPeriod = ctx.paramInt("shortPeriod", 5);
        int longPeriod  = ctx.paramInt("longPeriod",  20);

        if (shortPeriod >= longPeriod) {
            return StrategyResult.hold("Invalid config: shortPeriod (" + shortPeriod +
                    ") must be less than longPeriod (" + longPeriod + ")");
        }

        // Maintain sliding window of size longPeriod + 1 per instance
        int windowSize = longPeriod + 1;
        ArrayDeque<BigDecimal> window = priceWindows.computeIfAbsent(ctx.getInstanceId(), k -> new ArrayDeque<>());
        window.addLast(ctx.getCandleClose());
        while (window.size() > windowSize) window.pollFirst();

        if (window.size() < windowSize) {
            return StrategyResult.hold(
                    "Warming up: " + window.size() + "/" + windowSize + " candles collected",
                    Map.of("collectedCandles", window.size(), "requiredCandles", windowSize));
        }

        // prices[0] = oldest, prices[windowSize-1] = newest
        List<BigDecimal> prices = new ArrayList<>(window);

        // Previous bar: prices[0 .. longPeriod-1]
        BigDecimal longSmaPrev  = sma(prices, 0,                          longPeriod);
        BigDecimal shortSmaPrev = sma(prices, longPeriod - shortPeriod,   shortPeriod);

        // Current bar: prices[1 .. longPeriod]
        BigDecimal longSmaCur   = sma(prices, 1,                          longPeriod);
        BigDecimal shortSmaCur  = sma(prices, windowSize - shortPeriod,   shortPeriod);

        Map<String, Object> meta = Map.of(
                "shortPeriod",  shortPeriod,
                "longPeriod",   longPeriod,
                "shortSmaCur",  shortSmaCur,
                "longSmaCur",   longSmaCur,
                "shortSmaPrev", shortSmaPrev,
                "longSmaPrev",  longSmaPrev,
                "close",        ctx.getCandleClose()
        );

        // Crossover: short was <= long, now short > long → BUY
        if (shortSmaPrev.compareTo(longSmaPrev) <= 0 && shortSmaCur.compareTo(longSmaCur) > 0) {
            log.info("BUY signal: instanceId={}, symbol={}, short={}, long={}",
                    ctx.getInstanceId(), ctx.getSymbol(), shortSmaCur, longSmaCur);
            return StrategyResult.buy(
                    "SMA crossover — short(" + shortPeriod + ")=" + shortSmaCur +
                    " crossed above long(" + longPeriod + ")=" + longSmaCur, meta);
        }

        // Crossunder: short was >= long, now short < long → SELL
        if (shortSmaPrev.compareTo(longSmaPrev) >= 0 && shortSmaCur.compareTo(longSmaCur) < 0) {
            log.info("SELL signal: instanceId={}, symbol={}, short={}, long={}",
                    ctx.getInstanceId(), ctx.getSymbol(), shortSmaCur, longSmaCur);
            return StrategyResult.sell(
                    "SMA crossunder — short(" + shortPeriod + ")=" + shortSmaCur +
                    " crossed below long(" + longPeriod + ")=" + longSmaCur, meta);
        }

        return StrategyResult.hold(
                "No crossover — short=" + shortSmaCur + ", long=" + longSmaCur, meta);
    }

    @Override
    public void onInstanceRemoved(String instanceId) {
        priceWindows.remove(instanceId);
        log.debug("Cleared price window for removed instance: {}", instanceId);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /** Computes the simple moving average of {@code period} values starting at {@code fromIndex}. */
    private static BigDecimal sma(List<BigDecimal> prices, int fromIndex, int period) {
        BigDecimal sum = BigDecimal.ZERO;
        for (int i = fromIndex; i < fromIndex + period; i++) {
            sum = sum.add(prices.get(i));
        }
        return sum.divide(BigDecimal.valueOf(period), 4, RoundingMode.HALF_UP);
    }
}
