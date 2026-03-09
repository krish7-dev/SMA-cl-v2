package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * VWAP Pullback / Crossover strategy.
 *
 * Uses a rolling Volume-Weighted Average Price over {@code lookback} candles.
 *   Typical price = (High + Low + Close) / 3
 *   VWAP          = Σ(typicalPrice × volume) / Σ(volume)
 *
 * Signal rules (price crossing VWAP):
 *   BUY  — previous close was BELOW rolling VWAP, current close is ABOVE → bullish reclaim
 *   SELL — previous close was ABOVE rolling VWAP, current close is BELOW → bearish rejection
 *
 * Parameters:
 *   lookback — rolling window size (default: 20)
 */
@Slf4j
@Component
public class VwapPullbackStrategy implements StrategyLogic {

    public static final String TYPE = "VWAP_PULLBACK";

    private static class State {
        final Deque<double[]> window = new ArrayDeque<>(); // [typicalPrice * volume, volume]
        double prevClose = Double.NaN;
        double prevVwap  = Double.NaN;
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int lookback = ctx.paramInt("lookback", 20);

        double high   = ctx.getCandleHigh().doubleValue();
        double low    = ctx.getCandleLow().doubleValue();
        double close  = ctx.getCandleClose().doubleValue();
        long   volume = ctx.getCandleVolume();

        double typical = (high + low + close) / 3.0;
        double tpv     = typical * volume;

        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());

        // Add to window
        s.window.addLast(new double[]{ tpv, volume });
        if (s.window.size() > lookback) s.window.pollFirst();

        // Compute current VWAP
        double sumTpv = s.window.stream().mapToDouble(e -> e[0]).sum();
        double sumVol = s.window.stream().mapToDouble(e -> e[1]).sum();
        double vwap   = sumVol > 0 ? sumTpv / sumVol : close;

        if (s.window.size() < lookback || Double.isNaN(s.prevClose) || Double.isNaN(s.prevVwap)) {
            s.prevClose = close;
            s.prevVwap  = vwap;
            return StrategyResult.hold("Warming up: " + s.window.size() + "/" + lookback);
        }

        Map<String, Object> meta = Map.of(
                "close", close, "vwap", r2(vwap), "prevClose", r2(s.prevClose),
                "prevVwap", r2(s.prevVwap), "lookback", lookback);

        StrategyResult result;

        if (s.prevClose < s.prevVwap && close > vwap) {
            log.info("BUY [VWAP_PULLBACK]: instanceId={}, close={}, vwap={}",
                    ctx.getInstanceId(), close, r2(vwap));
            result = StrategyResult.buy("Price reclaimed VWAP: close=" + close + " vwap=" + r2(vwap), meta);
        } else if (s.prevClose > s.prevVwap && close < vwap) {
            log.info("SELL [VWAP_PULLBACK]: instanceId={}, close={}, vwap={}",
                    ctx.getInstanceId(), close, r2(vwap));
            result = StrategyResult.sell("Price fell below VWAP: close=" + close + " vwap=" + r2(vwap), meta);
        } else {
            result = StrategyResult.hold("VWAP=" + r2(vwap), meta);
        }

        s.prevClose = close;
        s.prevVwap  = vwap;
        return result;
    }

    @Override public void onInstanceRemoved(String id) { states.remove(id); }

    private static double r2(double v) { return Math.round(v * 100.0) / 100.0; }
}
