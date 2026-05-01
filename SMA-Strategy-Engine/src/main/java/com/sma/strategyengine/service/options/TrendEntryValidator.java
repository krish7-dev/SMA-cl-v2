package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.service.options.NiftyDecisionResult.Bias;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.util.List;

/**
 * Structure-based entry validator for the TRENDING regime.
 *
 * Hard blocks first, then requires at least one allow-path:
 *   A. Breakout entry  — close beyond highest/lowest of last N candles
 *   B. Strong candle   — large body AND close near the favourable extreme
 *   C. Momentum        — close better than previous close AND EMA9 slope in bias direction
 */
@Slf4j
public class TrendEntryValidator {

    private final OptionsReplayRequest.TrendEntryConfig cfg;

    public TrendEntryValidator(OptionsReplayRequest.TrendEntryConfig cfg) {
        this.cfg = cfg != null ? cfg : new OptionsReplayRequest.TrendEntryConfig();
    }

    // ── Result ────────────────────────────────────────────────────────────────

    @Getter
    public static class Result {
        private final boolean allowed;
        private final String  reason;

        Result(boolean allowed, String reason) {
            this.allowed = allowed;
            this.reason  = reason;
        }

        static Result ok(String reason)   { return new Result(true,  reason); }
        static Result fail(String reason) { return new Result(false, reason); }
    }

    // ── Main validation ───────────────────────────────────────────────────────

    public Result validate(List<CandleDto> history, Bias bias) {
        return validate(history, bias, 0);
    }

    public Result validate(List<CandleDto> history, Bias bias, double winnerScore) {
        if (!cfg.isEnabled()) return Result.ok("disabled");
        if (bias == Bias.NEUTRAL) return Result.fail("no directional bias");

        int size = history.size();
        if (size < 2) return Result.ok("insufficient history");

        CandleDto cur  = history.get(size - 1);
        CandleDto prev = history.get(size - 2);

        double open  = cur.open().doubleValue();
        double high  = cur.high().doubleValue();
        double low   = cur.low().doubleValue();
        double close = cur.close().doubleValue();

        double range = high - low;
        double bodyPct = range > 0 ? Math.abs(close - open) / range * 100.0 : 0.0;

        // ── Hard block A: inside bar ──────────────────────────────────────────
        double prevHigh = prev.high().doubleValue();
        double prevLow  = prev.low().doubleValue();
        if (high <= prevHigh && low >= prevLow) {
            return Result.fail("inside bar");
        }

        // ── Hard block B: weak candle body ────────────────────────────────────
        if (bodyPct < cfg.getWeakBodyPct()) {
            if (cfg.isScoreBypassWeakBody() && winnerScore >= cfg.getScoreBypassWeakBodyThreshold()) {
                log.debug("[TREND] Weak-body bypass: body={}% < {}% but score={} >= threshold={}",
                        String.format("%.1f", bodyPct), cfg.getWeakBodyPct(),
                        String.format("%.1f", winnerScore), cfg.getScoreBypassWeakBodyThreshold());
            } else {
                return Result.fail(String.format("weak body %.1f%% < %.1f%%", bodyPct, cfg.getWeakBodyPct()));
            }
        }

        // ── Allow path 1: breakout ────────────────────────────────────────────
        int n = cfg.getBreakoutLookback();
        if (size - 1 >= n) {
            // Window: n candles before current (excludes current)
            List<CandleDto> window = history.subList(size - 1 - n, size - 1);
            if (bias == Bias.BULLISH) {
                double highestHigh = window.stream()
                        .mapToDouble(c -> c.high().doubleValue()).max().orElse(Double.MIN_VALUE);
                if (close > highestHigh) return Result.ok("breakout above " + String.format("%.2f", highestHigh));
            } else {
                double lowestLow = window.stream()
                        .mapToDouble(c -> c.low().doubleValue()).min().orElse(Double.MAX_VALUE);
                if (close < lowestLow) return Result.ok("breakout below " + String.format("%.2f", lowestLow));
            }
        }

        // ── Allow path 2: strong candle ───────────────────────────────────────
        if (bodyPct >= cfg.getMinBodyPct() && range > 0) {
            // Close must be in the top 40% (BULLISH) or bottom 40% (BEARISH) of the candle range
            double closeRatio = (close - low) / range; // 0 = at low, 1 = at high
            boolean closeNearExtreme = (bias == Bias.BULLISH)
                    ? closeRatio >= 0.6
                    : closeRatio <= 0.4;
            if (closeNearExtreme) {
                return Result.ok(String.format("strong candle body=%.1f%% closeRatio=%.2f", bodyPct, closeRatio));
            }
        }

        // ── Allow path 3: momentum + EMA slope ───────────────────────────────
        double prevClose = prev.close().doubleValue();
        boolean closeBetter = (bias == Bias.BULLISH) ? (close > prevClose) : (close < prevClose);

        if (closeBetter) {
            int period = cfg.getEma9Period();
            double[] emaPair = computeEmaPair(history, period);
            if (emaPair != null) {
                boolean slopeOk = (bias == Bias.BULLISH)
                        ? emaPair[1] > emaPair[0]
                        : emaPair[1] < emaPair[0];
                if (slopeOk) return Result.ok("momentum + EMA" + period + " slope");
            }
        }

        return Result.fail("no valid entry structure (body=" + String.format("%.1f", bodyPct) + "%)");
    }

    // ── EMA helper ────────────────────────────────────────────────────────────

    /**
     * Returns [emaPrev, emaCurrent] — the two most-recent EMA values —
     * or null if there are fewer than 2 candles in the window.
     */
    private double[] computeEmaPair(List<CandleDto> history, int period) {
        int size = history.size();
        if (size < 2) return null;

        // Warm-up window: up to 3× period candles before end
        int startIdx = Math.max(0, size - period * 3);
        double multiplier = 2.0 / (period + 1);

        // Seed EMA at first close in the window
        double ema = history.get(startIdx).close().doubleValue();
        double emaPrev = ema;

        for (int i = startIdx + 1; i < size; i++) {
            emaPrev = ema;
            double c = history.get(i).close().doubleValue();
            ema = c * multiplier + ema * (1.0 - multiplier);
        }

        return new double[]{ emaPrev, ema };
    }
}
