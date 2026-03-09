package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Relative Strength Index (RSI) strategy — Wilder's smoothing method.
 *
 * Signal rules:
 *   BUY  — RSI crosses ABOVE the oversold threshold (default 30)
 *   SELL — RSI crosses BELOW the overbought threshold (default 70)
 *   HOLD — no threshold crossing, or still warming up
 *
 * Parameters:
 *   period     — lookback period for RSI calculation (default: 14)
 *   oversold   — buy trigger level                   (default: 30)
 *   overbought — sell trigger level                  (default: 70)
 *
 * Warmup: period + 1 candles.
 *   Candle 1          : records first close (no change yet).
 *   Candles 2..period : accumulates price changes.
 *   Candle period + 1 : seeds avgGain/avgLoss via SMA of the first period changes,
 *                       then switches to Wilder's exponential smoothing thereafter.
 */
@Slf4j
@Component
public class RsiStrategy implements StrategyLogic {

    public static final String TYPE = "RSI";

    private static class State {
        int count = 0;
        double prevClose = Double.NaN;
        double avgGain   = 0;
        double avgLoss   = 0;
        double prevRsi   = Double.NaN;
        List<Double> warmupChanges = new ArrayList<>();
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override
    public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int    period     = ctx.paramInt("period",        14);
        double oversold   = ctx.paramDouble("oversold",   30.0);
        double overbought = ctx.paramDouble("overbought", 70.0);

        double close = ctx.getCandleClose().doubleValue();
        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());
        s.count++;

        // First candle: no prior close to diff against
        if (s.count == 1) {
            s.prevClose = close;
            return StrategyResult.hold("Warming up: 1/" + (period + 1) + " candles");
        }

        double change = close - s.prevClose;
        double gain   = Math.max(change,  0.0);
        double loss   = Math.max(-change, 0.0);
        s.prevClose   = close;

        // Collect first period changes for initial SMA seed
        if (s.count <= period) {
            s.warmupChanges.add(change);
            return StrategyResult.hold("Warming up: " + s.count + "/" + (period + 1) + " candles");
        }

        // candle period + 1: seed avgGain/avgLoss via SMA of all period changes
        if (s.count == period + 1) {
            double sumGain = gain, sumLoss = loss;   // current change is the period-th
            for (double c : s.warmupChanges) {
                if (c > 0) sumGain += c;
                else       sumLoss += (-c);
            }
            s.avgGain      = sumGain / period;
            s.avgLoss      = sumLoss / period;
            s.warmupChanges = null;
        } else {
            // Wilder's smoothing
            s.avgGain = (s.avgGain * (period - 1) + gain) / period;
            s.avgLoss = (s.avgLoss * (period - 1) + loss) / period;
        }

        double rsi     = s.avgLoss == 0 ? 100.0 : 100.0 - (100.0 / (1.0 + s.avgGain / s.avgLoss));
        double prevRsi = s.prevRsi;
        s.prevRsi      = rsi;

        // First RSI computed — record but no crossover to compare
        if (Double.isNaN(prevRsi)) {
            return StrategyResult.hold("RSI ready: " + r2(rsi), Map.of("rsi", r2(rsi)));
        }

        Map<String, Object> meta = Map.of(
                "period", period, "oversold", oversold, "overbought", overbought,
                "rsi", r2(rsi), "prevRsi", r2(prevRsi), "close", close
        );

        // BUY: RSI crosses above oversold
        if (prevRsi <= oversold && rsi > oversold) {
            log.info("BUY [RSI]: instanceId={}, symbol={}, rsi={}",
                    ctx.getInstanceId(), ctx.getSymbol(), r2(rsi));
            return StrategyResult.buy(
                    "RSI crossed above oversold(" + oversold + "): RSI=" + r2(rsi), meta);
        }

        // SELL: RSI crosses below overbought
        if (prevRsi >= overbought && rsi < overbought) {
            log.info("SELL [RSI]: instanceId={}, symbol={}, rsi={}",
                    ctx.getInstanceId(), ctx.getSymbol(), r2(rsi));
            return StrategyResult.sell(
                    "RSI crossed below overbought(" + overbought + "): RSI=" + r2(rsi), meta);
        }

        return StrategyResult.hold("RSI=" + r2(rsi), meta);
    }

    @Override
    public void onInstanceRemoved(String instanceId) {
        states.remove(instanceId);
        log.debug("Cleared RSI state for removed instance: {}", instanceId);
    }

    private static double r2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
