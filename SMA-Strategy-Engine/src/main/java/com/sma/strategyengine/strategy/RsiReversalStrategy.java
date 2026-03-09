package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * RSI Reversal — RSI + price momentum confirmation.
 *
 * Differences from plain RSI:
 *   BUY  — RSI is in oversold zone (< oversold) AND RSI is turning up (rsi > prevRsi)
 *   SELL — RSI is in overbought zone (> overbought) AND RSI is turning down (rsi < prevRsi)
 *
 * This filters out RSI entries that are still falling while oversold, waiting for the
 * actual reversal momentum before triggering — fewer but higher-confidence signals.
 *
 * Parameters:
 *   period     — RSI lookback (default: 14)
 *   oversold   — oversold level (default: 30)
 *   overbought — overbought level (default: 70)
 */
@Slf4j
@Component
public class RsiReversalStrategy implements StrategyLogic {

    public static final String TYPE = "RSI_REVERSAL";

    private static class State {
        int count = 0;
        double prevClose = Double.NaN;
        double avgGain   = 0;
        double avgLoss   = 0;
        double prevRsi   = Double.NaN;
        List<Double> warmupChanges = new ArrayList<>();
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int    period     = ctx.paramInt("period",        14);
        double oversold   = ctx.paramDouble("oversold",   30.0);
        double overbought = ctx.paramDouble("overbought", 70.0);

        double close = ctx.getCandleClose().doubleValue();
        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());
        s.count++;

        if (s.count == 1) { s.prevClose = close; return StrategyResult.hold("Warming up"); }

        double change = close - s.prevClose;
        double gain   = Math.max(change, 0.0);
        double loss   = Math.max(-change, 0.0);
        s.prevClose = close;

        if (s.count <= period) {
            s.warmupChanges.add(change);
            return StrategyResult.hold("Warming up: " + s.count + "/" + (period + 1));
        }
        if (s.count == period + 1) {
            double sg = gain, sl = loss;
            for (double c : s.warmupChanges) { if (c > 0) sg += c; else sl += (-c); }
            s.avgGain = sg / period;
            s.avgLoss = sl / period;
            s.warmupChanges = null;
        } else {
            s.avgGain = (s.avgGain * (period - 1) + gain) / period;
            s.avgLoss = (s.avgLoss * (period - 1) + loss) / period;
        }

        double rsi    = s.avgLoss == 0 ? 100.0 : 100.0 - (100.0 / (1.0 + s.avgGain / s.avgLoss));
        double prev   = s.prevRsi;
        s.prevRsi     = rsi;

        if (Double.isNaN(prev)) return StrategyResult.hold("RSI ready: " + r2(rsi));

        Map<String, Object> meta = Map.of(
                "rsi", r2(rsi), "prevRsi", r2(prev), "oversold", oversold, "overbought", overbought);

        // BUY: oversold zone AND RSI turning up
        if (rsi < oversold && rsi > prev) {
            log.info("BUY [RSI_REVERSAL]: instanceId={}, rsi={}", ctx.getInstanceId(), r2(rsi));
            return StrategyResult.buy("RSI reversal up in oversold: " + r2(rsi), meta);
        }
        // SELL: overbought zone AND RSI turning down
        if (rsi > overbought && rsi < prev) {
            log.info("SELL [RSI_REVERSAL]: instanceId={}, rsi={}", ctx.getInstanceId(), r2(rsi));
            return StrategyResult.sell("RSI reversal down in overbought: " + r2(rsi), meta);
        }
        return StrategyResult.hold("RSI=" + r2(rsi), meta);
    }

    @Override public void onInstanceRemoved(String id) { states.remove(id); }

    private static double r2(double v) { return Math.round(v * 100.0) / 100.0; }
}
