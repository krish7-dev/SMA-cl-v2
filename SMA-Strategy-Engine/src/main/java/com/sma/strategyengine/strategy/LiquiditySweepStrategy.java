package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Liquidity Sweep strategy (Smart Money Concepts).
 *
 * Liquidity pools form at the highs and lows of recent candles (stop-loss clusters).
 * A "sweep" occurs when price briefly violates a liquidity level then reverses,
 * signalling that institutional players have absorbed the orders.
 *
 * Signal rules (evaluated on the CURRENT candle's wicks vs the PRIOR N-bar range):
 *   BUY  — candle LOW dips BELOW prior {lookback}-bar low (buy-side liquidity swept)
 *           AND candle CLOSE is ABOVE that prior low (reversal confirmed within the bar)
 *
 *   SELL — candle HIGH spikes ABOVE prior {lookback}-bar high (sell-side liquidity swept)
 *           AND candle CLOSE is BELOW that prior high (reversal confirmed within the bar)
 *
 * Parameters:
 *   lookback — number of prior candles to define the liquidity pool (default: 10)
 */
@Slf4j
@Component
public class LiquiditySweepStrategy implements StrategyLogic {

    public static final String TYPE = "LIQUIDITY_SWEEP";

    private static class State {
        final Deque<double[]> window = new ArrayDeque<>(); // [high, low] of each prior candle
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int lookback = ctx.paramInt("lookback", 10);

        double high  = ctx.getCandleHigh().doubleValue();
        double low   = ctx.getCandleLow().doubleValue();
        double close = ctx.getCandleClose().doubleValue();

        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());

        StrategyResult result;

        if (s.window.size() < lookback) {
            result = StrategyResult.hold("Warming up: " + s.window.size() + "/" + lookback);
        } else {
            double poolHigh = s.window.stream().mapToDouble(e -> e[0]).max().orElse(high);
            double poolLow  = s.window.stream().mapToDouble(e -> e[1]).min().orElse(low);

            Map<String, Object> meta = Map.of(
                    "close", close, "high", high, "low", low,
                    "poolHigh", r2(poolHigh), "poolLow", r2(poolLow), "lookback", lookback);

            if (low < poolLow && close > poolLow) {
                // Wick pierced below prior low, but bar closed back above it
                log.info("BUY [LIQUIDITY_SWEEP]: instanceId={}, low={} swept poolLow={}, close={}",
                        ctx.getInstanceId(), low, r2(poolLow), close);
                result = StrategyResult.buy(
                        "Buy-side liquidity swept: low=" + low + " < poolLow=" + r2(poolLow)
                        + ", closed above at " + close, meta);
            } else if (high > poolHigh && close < poolHigh) {
                // Wick pierced above prior high, but bar closed back below it
                log.info("SELL [LIQUIDITY_SWEEP]: instanceId={}, high={} swept poolHigh={}, close={}",
                        ctx.getInstanceId(), high, r2(poolHigh), close);
                result = StrategyResult.sell(
                        "Sell-side liquidity swept: high=" + high + " > poolHigh=" + r2(poolHigh)
                        + ", closed below at " + close, meta);
            } else {
                result = StrategyResult.hold(
                        "No sweep | pool [" + r2(poolLow) + ", " + r2(poolHigh) + "]", meta);
            }
        }

        // Slide window forward with the current candle
        s.window.addLast(new double[]{ high, low });
        if (s.window.size() > lookback) s.window.pollFirst();

        return result;
    }

    @Override public void onInstanceRemoved(String id) { states.remove(id); }

    private static double r2(double v) { return Math.round(v * 100.0) / 100.0; }
}
