package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.util.*;

/**
 * Range Quality Filter — applied ONLY in RANGING regime before trade entry.
 *
 * Evaluates whether the recent price action represents a clean, tradeable range
 * by checking:
 *   A) Bollinger band touches (upper + lower) over lookback window
 *   B) Range width (% of close) — too narrow or too wide = poor range
 *   C) Directional drift — sustained drift disqualifies the range
 *   D) Chop check — excessive direction flips = noise, not a range
 *
 * Bollinger Bands are computed independently (SMA-20 ± 2σ) per candle in the
 * lookback window.  This mirrors the BOLLINGER_REVERSION strategy defaults.
 */
@Slf4j
public class RangeQualityFilter {

    /** Standard Bollinger Band defaults (must match BOLLINGER_REVERSION strategy). */
    private static final int    BB_PERIOD = 20;
    private static final double BB_MULT   = 2.0;

    private final OptionsReplayRequest.RangeQualityConfig cfg;

    public RangeQualityFilter(OptionsReplayRequest.RangeQualityConfig cfg) {
        this.cfg = cfg != null ? cfg : new OptionsReplayRequest.RangeQualityConfig();
    }

    // ── Result ────────────────────────────────────────────────────────────────

    @Getter
    public static class Result {
        private final boolean allowed;
        private final String  reason;
        private final int     upperTouches;
        private final int     lowerTouches;
        private final double  rangePct;
        private final double  driftRatio;
        private final double  flipRatio;

        Result(boolean allowed, String reason,
               int upperTouches, int lowerTouches,
               double rangePct, double driftRatio, double flipRatio) {
            this.allowed      = allowed;
            this.reason       = reason;
            this.upperTouches = upperTouches;
            this.lowerTouches = lowerTouches;
            this.rangePct     = rangePct;
            this.driftRatio   = driftRatio;
            this.flipRatio    = flipRatio;
        }
    }

    // ── Evaluation ────────────────────────────────────────────────────────────

    /**
     * Evaluate range quality from the rolling candle history.
     *
     * @param historyDeque  rolling NIFTY candle history maintained by the decision engine
     * @return Result with allowed=true to proceed, or allowed=false with a block reason
     */
    public Result evaluate(Deque<CandleDto> historyDeque) {
        if (!cfg.isEnabled()) return pass("disabled");

        int n        = cfg.getLookbackBars();
        int required = n + BB_PERIOD;

        List<CandleDto> hist = new ArrayList<>(historyDeque);
        if (hist.size() < required) return pass("insufficient history");

        // Last N candles for analysis
        List<CandleDto> recent = hist.subList(hist.size() - n, hist.size());

        double lastClose  = recent.get(n - 1).close().doubleValue();
        double firstClose = recent.get(0).close().doubleValue();
        if (lastClose <= 0) return pass("invalid close");

        // ── B: Range width ────────────────────────────────────────────────────
        double highestHigh = Double.NEGATIVE_INFINITY;
        double lowestLow   = Double.POSITIVE_INFINITY;
        for (CandleDto c : recent) {
            if (c.high() != null) highestHigh = Math.max(highestHigh, c.high().doubleValue());
            if (c.low()  != null) lowestLow   = Math.min(lowestLow,  c.low().doubleValue());
        }
        if (highestHigh <= lowestLow) return fail("RANGE_TOO_NARROW", "range size is zero",
                0, 0, 0, 0, 0);

        double rangeSize = highestHigh - lowestLow;
        double rangePct  = rangeSize / lastClose * 100.0;

        if (rangePct < cfg.getMinRangeWidthPct())
            return fail("RANGE_TOO_NARROW",
                    String.format("rangePct=%.2f%% < min=%.2f%%", rangePct, cfg.getMinRangeWidthPct()),
                    0, 0, rangePct, 0, 0);

        if (rangePct > cfg.getMaxRangeWidthPct())
            return fail("RANGE_TOO_WIDE",
                    String.format("rangePct=%.2f%% > max=%.2f%%", rangePct, cfg.getMaxRangeWidthPct()),
                    0, 0, rangePct, 0, 0);

        // ── C: Directional drift ─────────────────────────────────────────────
        double driftRatio = Math.abs(lastClose - firstClose) / rangeSize;
        if (driftRatio > cfg.getMaxDirectionalDriftPctOfRange())
            return fail("RANGE_DRIFTING",
                    String.format("driftRatio=%.2f > max=%.2f", driftRatio, cfg.getMaxDirectionalDriftPctOfRange()),
                    0, 0, rangePct, driftRatio, 0);

        // ── A: Bollinger band touches ─────────────────────────────────────────
        // For each candle in the lookback window, compute the BB from the
        // preceding BB_PERIOD closes (so band values match what strategy sees).
        double tolerance   = cfg.getBandTouchTolerancePct() / 100.0;
        int upperTouches   = 0;
        int lowerTouches   = 0;

        for (int i = 0; i < n; i++) {
            int bbEnd = hist.size() - n + i; // index of this candle in hist
            // BB window: [bbEnd - BB_PERIOD, bbEnd) — does NOT include this candle
            if (bbEnd < BB_PERIOD) continue;
            List<CandleDto> bbWindow = hist.subList(bbEnd - BB_PERIOD, bbEnd);

            double sum = 0, sumSq = 0;
            for (CandleDto bc : bbWindow) {
                double cl = bc.close().doubleValue();
                sum  += cl;
                sumSq += cl * cl;
            }
            double sma = sum / BB_PERIOD;
            double std = Math.sqrt(Math.max(0, sumSq / BB_PERIOD - sma * sma));

            double upper = sma + BB_MULT * std;
            double lower = sma - BB_MULT * std;

            CandleDto c  = recent.get(i);
            double hi = c.high() != null ? c.high().doubleValue() : 0;
            double lo = c.low()  != null ? c.low().doubleValue()  : Double.MAX_VALUE;

            if (upper > 0 && hi >= upper * (1.0 - tolerance)) upperTouches++;
            if (lower > 0 && lo <= lower * (1.0 + tolerance)) lowerTouches++;
        }

        if (upperTouches < cfg.getMinUpperTouches() || lowerTouches < cfg.getMinLowerTouches())
            return fail("RANGE_POOR_STRUCTURE",
                    String.format("touches: upper=%d(min=%d) lower=%d(min=%d)",
                            upperTouches, cfg.getMinUpperTouches(),
                            lowerTouches, cfg.getMinLowerTouches()),
                    upperTouches, lowerTouches, rangePct, driftRatio, 0);

        // ── D: Chop check ─────────────────────────────────────────────────────
        double flipRatio = 0;
        if (cfg.isEnableChopCheck() && n > 2) {
            int flips = 0;
            for (int i = 2; i < n; i++) {
                double p0 = recent.get(i - 2).close().doubleValue();
                double p1 = recent.get(i - 1).close().doubleValue();
                double p2 = recent.get(i).close().doubleValue();
                boolean prevUp = p1 > p0;
                boolean currUp = p2 > p1;
                if (prevUp != currUp) flips++;
            }
            // flips / (n-1) per spec; max flips is n-2
            flipRatio = (double) flips / (n - 1);
            if (flipRatio > cfg.getChopFlipRatioLimit())
                return fail("RANGE_CHOPPY",
                        String.format("flipRatio=%.2f > limit=%.2f", flipRatio, cfg.getChopFlipRatioLimit()),
                        upperTouches, lowerTouches, rangePct, driftRatio, flipRatio);
        }

        return new Result(true, "OK", upperTouches, lowerTouches, rangePct, driftRatio, flipRatio);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Result pass(String reason) {
        return new Result(true, reason, 0, 0, 0, 0, 0);
    }

    private Result fail(String reason, String detail,
                        int ut, int lt, double rangePct, double driftRatio, double flipRatio) {
        return new Result(false, reason + ": " + detail, ut, lt, rangePct, driftRatio, flipRatio);
    }
}
