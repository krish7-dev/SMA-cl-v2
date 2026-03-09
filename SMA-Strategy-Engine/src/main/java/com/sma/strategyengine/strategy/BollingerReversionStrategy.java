package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Bollinger Bands Mean Reversion strategy.
 *
 *   Middle band = SMA(close, period)
 *   Upper band  = Middle + multiplier × std dev
 *   Lower band  = Middle − multiplier × std dev
 *
 * Signal rules (mean reversion — fades extremes):
 *   BUY  — close drops BELOW the lower band (oversold, expect bounce toward mean)
 *   SELL — close rises ABOVE the upper band (overbought, expect reversion to mean)
 *   HOLD — price is within the bands
 *
 * Parameters:
 *   period     — SMA / std dev window (default: 20)
 *   multiplier — band width in std deviations (default: 2.0)
 */
@Slf4j
@Component
public class BollingerReversionStrategy implements StrategyLogic {

    public static final String TYPE = "BOLLINGER_REVERSION";

    private static class State {
        final Deque<Double> window = new ArrayDeque<>();
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int    period     = ctx.paramInt("period",        20);
        double multiplier = ctx.paramDouble("multiplier", 2.0);

        double close = ctx.getCandleClose().doubleValue();
        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());

        s.window.addLast(close);
        if (s.window.size() > period) s.window.pollFirst();

        if (s.window.size() < period) {
            return StrategyResult.hold("Warming up: " + s.window.size() + "/" + period);
        }

        double[] arr    = s.window.stream().mapToDouble(Double::doubleValue).toArray();
        double   mean   = java.util.Arrays.stream(arr).average().orElse(close);
        double   sumSq  = java.util.Arrays.stream(arr).map(v -> (v - mean) * (v - mean)).sum();
        double   stdDev = Math.sqrt(sumSq / period);

        double upper = mean + multiplier * stdDev;
        double lower = mean - multiplier * stdDev;

        Map<String, Object> meta = Map.of(
                "close", close, "sma", r2(mean), "upper", r2(upper),
                "lower", r2(lower), "stdDev", r2(stdDev));

        if (close < lower) {
            log.info("BUY [BOLLINGER_REVERSION]: instanceId={}, close={}, lower={}",
                    ctx.getInstanceId(), close, r2(lower));
            return StrategyResult.buy("Close below lower band: " + close + " < " + r2(lower), meta);
        }
        if (close > upper) {
            log.info("SELL [BOLLINGER_REVERSION]: instanceId={}, close={}, upper={}",
                    ctx.getInstanceId(), close, r2(upper));
            return StrategyResult.sell("Close above upper band: " + close + " > " + r2(upper), meta);
        }
        return StrategyResult.hold("Within bands [" + r2(lower) + ", " + r2(upper) + "]", meta);
    }

    @Override public void onInstanceRemoved(String id) { states.remove(id); }

    private static double r2(double v) { return Math.round(v * 100.0) / 100.0; }
}
