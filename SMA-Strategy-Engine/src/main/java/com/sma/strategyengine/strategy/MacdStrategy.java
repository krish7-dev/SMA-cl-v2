package com.sma.strategyengine.strategy;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * MACD (Moving Average Convergence Divergence) strategy.
 *
 *   MACD line   = fastEMA − slowEMA
 *   Signal line = EMA(MACD line, signalPeriod)
 *   Histogram   = MACD line − Signal line
 *
 * Signal rules:
 *   BUY  — MACD line crosses ABOVE the signal line
 *   SELL — MACD line crosses BELOW the signal line
 *   HOLD — no crossover, or still warming up
 *
 * Parameters:
 *   fastPeriod   — fast EMA period   (default: 12)
 *   slowPeriod   — slow EMA period   (default: 26)
 *   signalPeriod — signal EMA period (default:  9)
 *
 * Warmup: slowPeriod + signalPeriod candles.
 *   Phase 1 (candles 1..slowPeriod)  : seed fast/slow EMA via SMA.
 *   Phase 2 (candles +1..+signalPeriod): compute MACD, seed signal EMA via SMA.
 *   Phase 3                           : live crossover detection.
 */
@Slf4j
@Component
public class MacdStrategy implements StrategyLogic {

    public static final String TYPE = "MACD";

    private static class State {
        int count = 0;
        double fastEma    = 0;
        double slowEma    = 0;
        double signalEma  = 0;
        double prevMacd   = Double.NaN;
        double prevSignal = Double.NaN;
        boolean signalReady = false;
        List<Double> priceWarmup = new ArrayList<>();
        List<Double> macdWarmup  = new ArrayList<>();
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    @Override
    public String type() { return TYPE; }

    @Override
    public StrategyResult evaluate(StrategyContext ctx) {
        int fastPeriod   = ctx.paramInt("fastPeriod",   12);
        int slowPeriod   = ctx.paramInt("slowPeriod",   26);
        int signalPeriod = ctx.paramInt("signalPeriod",  9);

        double close      = ctx.getCandleClose().doubleValue();
        double fastMult   = 2.0 / (fastPeriod   + 1);
        double slowMult   = 2.0 / (slowPeriod   + 1);
        double signalMult = 2.0 / (signalPeriod + 1);

        State s = states.computeIfAbsent(ctx.getInstanceId(), k -> new State());
        s.count++;

        // ── Phase 1: collect slowPeriod prices to seed fast/slow EMA via SMA ──
        if (s.count < slowPeriod) {
            s.priceWarmup.add(close);
            return StrategyResult.hold("Warming up [phase 1]: " + s.count + "/" + slowPeriod);
        }

        if (s.count == slowPeriod) {
            s.priceWarmup.add(close);
            s.slowEma     = average(s.priceWarmup, 0, slowPeriod);
            s.fastEma     = average(s.priceWarmup, slowPeriod - fastPeriod, fastPeriod);
            s.priceWarmup = null;
        } else {
            s.fastEma = close * fastMult + s.fastEma * (1 - fastMult);
            s.slowEma = close * slowMult + s.slowEma * (1 - slowMult);
        }

        double macd = s.fastEma - s.slowEma;

        // ── Phase 2: collect signalPeriod MACD values to seed signal EMA ──────
        if (!s.signalReady) {
            s.macdWarmup.add(macd);
            if (s.macdWarmup.size() < signalPeriod) {
                return StrategyResult.hold("Warming up [phase 2]: " +
                        s.macdWarmup.size() + "/" + signalPeriod);
            }
            s.signalEma   = average(s.macdWarmup, 0, signalPeriod);
            s.signalReady = true;
            s.macdWarmup  = null;
            s.prevMacd    = macd;
            s.prevSignal  = s.signalEma;
            return StrategyResult.hold("MACD ready — first cross check on next candle",
                    Map.of("macd", r4(macd), "signal", r4(s.signalEma)));
        }

        // ── Phase 3: live crossover detection ───────────────────────────────────
        double prevMacd   = s.prevMacd;
        double prevSignal = s.prevSignal;

        s.signalEma  = macd * signalMult + s.signalEma * (1 - signalMult);
        s.prevMacd   = macd;
        s.prevSignal = s.signalEma;

        Map<String, Object> meta = Map.of(
                "fastPeriod",   fastPeriod,       "slowPeriod",   slowPeriod,
                "signalPeriod", signalPeriod,
                "macd",         r4(macd),         "signal",       r4(s.signalEma),
                "histogram",    r4(macd - s.signalEma),
                "prevMacd",     r4(prevMacd),     "prevSignal",   r4(prevSignal),
                "close",        close
        );

        if (prevMacd <= prevSignal && macd > s.signalEma) {
            log.info("BUY [MACD]: instanceId={}, symbol={}, macd={}, signal={}",
                    ctx.getInstanceId(), ctx.getSymbol(), r4(macd), r4(s.signalEma));
            return StrategyResult.buy(
                    "MACD crossover — MACD=" + r4(macd) + " crossed above signal=" + r4(s.signalEma), meta);
        }

        if (prevMacd >= prevSignal && macd < s.signalEma) {
            log.info("SELL [MACD]: instanceId={}, symbol={}, macd={}, signal={}",
                    ctx.getInstanceId(), ctx.getSymbol(), r4(macd), r4(s.signalEma));
            return StrategyResult.sell(
                    "MACD crossunder — MACD=" + r4(macd) + " crossed below signal=" + r4(s.signalEma), meta);
        }

        return StrategyResult.hold(
                "MACD=" + r4(macd) + ", signal=" + r4(s.signalEma) + ", hist=" + r4(macd - s.signalEma), meta);
    }

    @Override
    public void onInstanceRemoved(String instanceId) {
        states.remove(instanceId);
        log.debug("Cleared MACD state for removed instance: {}", instanceId);
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
