package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.service.options.NiftyDecisionResult.Bias;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.util.List;

/**
 * Validates that a TRENDING regime signal represents a real trend and not a fake breakout.
 *
 * Six checks applied sequentially — all must pass:
 *   1. STRUCTURE     — HH-HL (LONG) or LH-LL (SHORT) across last 3 candles
 *   2. OVERLAP       — candles do not heavily overlap (compression detection)
 *   3. BODY_STRENGTH — average body ratio >= threshold; at least N strong bodies
 *   4. BREAKOUT_SUSTAIN — c[-2] breaks c[-3] extreme; c[-1] does not fully reverse
 *   5. RANGE_EXPANSION  — current candle range > avgRange * multiplier
 *   6. PERSISTENCE      — at least N consecutive directional candles before entry
 */
@Slf4j
public class RealTrendValidator {

    private final OptionsReplayRequest.RealTrendConfig cfg;

    public RealTrendValidator(OptionsReplayRequest.RealTrendConfig cfg) {
        this.cfg = cfg != null ? cfg : new OptionsReplayRequest.RealTrendConfig();
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
        if (!cfg.isEnabled()) return Result.ok("disabled");
        if (bias == Bias.NEUTRAL) return Result.fail("no directional bias");

        int size = history.size();
        if (size < 3) return Result.ok("insufficient history");

        // Last 3 candles: c0 = oldest, c1 = middle, c2 = current
        CandleDto c0 = history.get(size - 3);
        CandleDto c1 = history.get(size - 2);
        CandleDto c2 = history.get(size - 1);

        double h0 = c0.high().doubleValue(),  l0 = c0.low().doubleValue();
        double h1 = c1.high().doubleValue(),  l1 = c1.low().doubleValue();
        double h2 = c2.high().doubleValue(),  l2 = c2.low().doubleValue();
        double o0 = c0.open().doubleValue(),  cl0 = c0.close().doubleValue();
        double o1 = c1.open().doubleValue(),  cl1 = c1.close().doubleValue();
        double o2 = c2.open().doubleValue(),  cl2 = c2.close().doubleValue();

        double r0 = h0 - l0, r1 = h1 - l1, r2 = h2 - l2;
        double avgRange = (r0 + r1 + r2) / 3.0;

        // ── 1. Structure: HH-HL (LONG) / LH-LL (SHORT) ───────────────────────
        boolean structureOk = bias == Bias.BULLISH
                ? (h0 < h1 && h1 < h2 && l0 < l1 && l1 < l2)
                : (h0 > h1 && h1 > h2 && l0 > l1 && l1 > l2);
        if (!structureOk) {
            log.debug("TrendValidation FAILED: reason=STRUCTURE bias={} h=[{},{},{}] l=[{},{},{}]",
                    bias,
                    String.format("%.2f", h0), String.format("%.2f", h1), String.format("%.2f", h2),
                    String.format("%.2f", l0), String.format("%.2f", l1), String.format("%.2f", l2));
            return Result.fail("STRUCTURE");
        }

        // ── 2. Overlap: heavily overlapping candles → compression, not trend ──
        if (avgRange > 0) {
            double minHigh     = Math.min(h0, Math.min(h1, h2));
            double maxLow      = Math.max(l0, Math.max(l1, l2));
            double overlapRange = minHigh - maxLow;
            double overlapRatio = overlapRange / avgRange;
            if (overlapRatio > cfg.getMaxOverlapRatio()) {
                log.debug("TrendValidation FAILED: reason=OVERLAP overlapRatio={}",
                        String.format("%.2f", overlapRatio));
                return Result.fail("OVERLAP overlapRatio=" + String.format("%.2f", overlapRatio));
            }
        }

        // ── 3. Body strength ──────────────────────────────────────────────────
        double br0 = r0 > 0 ? Math.abs(cl0 - o0) / r0 : 0;
        double br1 = r1 > 0 ? Math.abs(cl1 - o1) / r1 : 0;
        double br2 = r2 > 0 ? Math.abs(cl2 - o2) / r2 : 0;
        double avgBodyRatio = (br0 + br1 + br2) / 3.0;
        int strongBodies = (br0 >= cfg.getMinStrongBodyRatio() ? 1 : 0)
                         + (br1 >= cfg.getMinStrongBodyRatio() ? 1 : 0)
                         + (br2 >= cfg.getMinStrongBodyRatio() ? 1 : 0);
        if (avgBodyRatio < cfg.getMinAvgBodyRatio() || strongBodies < cfg.getMinStrongBodies()) {
            log.debug("TrendValidation FAILED: reason=BODY_STRENGTH avgBodyRatio={} strongBodies={}",
                    String.format("%.2f", avgBodyRatio), strongBodies);
            return Result.fail("BODY_STRENGTH avgBody=" + String.format("%.2f", avgBodyRatio)
                    + " strong=" + strongBodies + "/" + cfg.getMinStrongBodies());
        }

        // ── 4. Breakout + Sustain ─────────────────────────────────────────────
        // c1 must break c0's extreme; c2 must not fully reverse c1
        double c1Mid = (h1 + l1) / 2.0;
        boolean breakout, sustain;
        if (bias == Bias.BULLISH) {
            breakout = cl1 > h0;
            sustain  = cl2 >= c1Mid;
        } else {
            breakout = cl1 < l0;
            sustain  = cl2 <= c1Mid;
        }
        if (!breakout || !sustain) {
            log.debug("TrendValidation FAILED: reason=BREAKOUT_SUSTAIN bias={} breakout={} sustain={}",
                    bias, breakout, sustain);
            return Result.fail("BREAKOUT_SUSTAIN breakout=" + breakout + " sustain=" + sustain);
        }

        // ── 5. Range expansion ────────────────────────────────────────────────
        if (avgRange > 0 && r2 < avgRange * cfg.getMinRangeExpansion()) {
            log.debug("TrendValidation FAILED: reason=RANGE_EXPANSION r2={} threshold={}",
                    String.format("%.2f", r2),
                    String.format("%.2f", avgRange * cfg.getMinRangeExpansion()));
            return Result.fail("RANGE_EXPANSION r2=" + String.format("%.2f", r2)
                    + " need>" + String.format("%.2f", avgRange * cfg.getMinRangeExpansion()));
        }

        // ── 6. Trend persistence ──────────────────────────────────────────────
        int required  = cfg.getMinPersistBars();
        int available = Math.min(required, size);
        int directionalCount = 0;
        for (int i = size - available; i < size; i++) {
            CandleDto c  = history.get(i);
            double    o  = c.open().doubleValue();
            double    cl = c.close().doubleValue();
            if (bias == Bias.BULLISH ? (cl > o) : (cl < o)) directionalCount++;
        }
        if (directionalCount < required) {
            log.debug("TrendValidation FAILED: reason=PERSISTENCE directional={} required={}",
                    directionalCount, required);
            return Result.fail("PERSISTENCE directional=" + directionalCount + " required=" + required);
        }

        log.debug("TrendValidation PASSED bias={}", bias);
        return Result.ok("PASSED");
    }
}
