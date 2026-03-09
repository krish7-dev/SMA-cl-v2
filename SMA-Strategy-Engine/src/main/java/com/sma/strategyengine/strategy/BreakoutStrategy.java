package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Donchian Channel Breakout strategy.
 *
 * BUY  — current close breaks ABOVE the highest high of the last {@code lookback} candles
 * SELL — current close breaks BELOW the lowest low  of the last {@code lookback} candles
 *
 * Uses the prior N candles (not including the current one) to form the channel,
 * so there is no look-ahead bias.
 *
 * Parameters:
 *   lookback — channel window (default: 20)
 */
@Slf4j
@Component
public class BreakoutStrategy implements StrategyLogic {

    public static final String TYPE = "BREAKOUT";

    private static class State {
        final Deque<double[]> window = new ArrayDeque<>(); // [high, low] pairs
        double prevHigh = Double.NaN;
        double prevLow  = Double.NaN;
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int lookback = ctx.paramInt("lookback", 20);

        double close = ctx.getCandleClose().doubleValue();
        double high  = ctx.getCandleHigh().doubleValue();
        double low   = ctx.getCandleHigh().doubleValue();
        low          = ctx.getCandleLow().doubleValue();

        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());

        // Signal based on PRIOR window (before adding current candle)
        StrategyResult result = null;
        if (s.window.size() >= lookback && !Double.isNaN(s.prevHigh)) {
            Map<String, Object> meta = Map.of(
                    "close", close, "channelHigh", r2(s.prevHigh),
                    "channelLow", r2(s.prevLow), "lookback", lookback);

            if (close > s.prevHigh) {
                log.info("BUY [BREAKOUT]: instanceId={}, close={}, channelHigh={}",
                        ctx.getInstanceId(), close, r2(s.prevHigh));
                result = StrategyResult.buy(
                        "Breakout above " + r2(s.prevHigh) + " (close=" + close + ")", meta);
            } else if (close < s.prevLow) {
                log.info("SELL [BREAKOUT]: instanceId={}, close={}, channelLow={}",
                        ctx.getInstanceId(), close, r2(s.prevLow));
                result = StrategyResult.sell(
                        "Breakdown below " + r2(s.prevLow) + " (close=" + close + ")", meta);
            } else {
                result = StrategyResult.hold(
                        "In channel [" + r2(s.prevLow) + ", " + r2(s.prevHigh) + "]", meta);
            }
        } else {
            result = StrategyResult.hold("Warming up: " + s.window.size() + "/" + lookback);
        }

        // Add current candle to window; evict oldest if over capacity
        s.window.addLast(new double[]{ high, low });
        if (s.window.size() > lookback) s.window.pollFirst();

        // Recompute channel high/low from the updated window for next candle
        s.prevHigh = s.window.stream().mapToDouble(e -> e[0]).max().orElse(Double.NaN);
        s.prevLow  = s.window.stream().mapToDouble(e -> e[1]).min().orElse(Double.NaN);

        return result;
    }

    @Override public void onInstanceRemoved(String id) { states.remove(id); }

    private static double r2(double v) { return Math.round(v * 100.0) / 100.0; }
}
