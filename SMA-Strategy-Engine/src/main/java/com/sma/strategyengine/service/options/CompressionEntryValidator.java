package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.service.options.NiftyDecisionResult.Bias;
import lombok.Getter;

import java.util.List;

/**
 * Structure-based entry validator for the COMPRESSION regime.
 *
 * Enforces mean-reversion logic: only trade at range extremes, never in
 * the middle of the range, and never when a breakout is already underway.
 *
 * rangePos = (close − rangeLow) / (rangeHigh − rangeLow)
 *   0.0 = at bottom of range   1.0 = at top of range
 *
 * BULLISH entry: rangePos ≤ longZoneMax  (near bottom)
 * BEARISH entry: rangePos ≥ shortZoneMin (near top)
 * No trade zone: noTradeZoneMin ≤ rangePos ≤ noTradeZoneMax
 */
public class CompressionEntryValidator {

    private final OptionsReplayRequest.CompressionEntryConfig cfg;

    public CompressionEntryValidator(OptionsReplayRequest.CompressionEntryConfig cfg) {
        this.cfg = cfg != null ? cfg : new OptionsReplayRequest.CompressionEntryConfig();
    }

    // ── Result ────────────────────────────────────────────────────────────────

    @Getter
    public static class Result {
        private final boolean allowed;
        private final String  reason;
        private final double  rangePos; // -1 if not computed

        Result(boolean allowed, String reason, double rangePos) {
            this.allowed  = allowed;
            this.reason   = reason;
            this.rangePos = rangePos;
        }

        static Result ok(String reason, double rangePos)   { return new Result(true,  reason, rangePos); }
        static Result fail(String reason, double rangePos) { return new Result(false, reason, rangePos); }
    }

    // ── Main validation ───────────────────────────────────────────────────────

    public Result validate(List<CandleDto> history, Bias bias) {
        if (!cfg.isEnabled()) return Result.ok("disabled", -1);
        if (bias == Bias.NEUTRAL) return Result.fail("no directional bias", -1);

        int size = history.size();
        int n    = cfg.getRangeLookback();

        if (size < n + 1) return Result.ok("insufficient history", -1);

        CandleDto cur = history.get(size - 1);

        // ── Define range from last N candles (excluding current) ──────────────
        List<CandleDto> window = history.subList(size - 1 - n, size - 1);

        double rangeHigh = window.stream()
                .mapToDouble(c -> c.high().doubleValue()).max().orElse(Double.MIN_VALUE);
        double rangeLow  = window.stream()
                .mapToDouble(c -> c.low().doubleValue()).min().orElse(Double.MAX_VALUE);

        if (rangeHigh <= rangeLow) return Result.ok("degenerate range", -1);

        double close    = cur.close().doubleValue();
        double curHigh  = cur.high().doubleValue();
        double curLow   = cur.low().doubleValue();
        double rangePos = (close - rangeLow) / (rangeHigh - rangeLow);

        // ── Block: current candle is breaking out of the range ────────────────
        if (cfg.isRejectBreakoutCandle()
                && (curHigh > rangeHigh || curLow < rangeLow)) {
            return Result.fail(String.format("breakout candle (h=%.2f vs rH=%.2f, l=%.2f vs rL=%.2f)",
                    curHigh, rangeHigh, curLow, rangeLow), rangePos);
        }

        // ── Block: no-trade zone (mid-range noise) ────────────────────────────
        if (rangePos >= cfg.getNoTradeZoneMin() && rangePos <= cfg.getNoTradeZoneMax()) {
            return Result.fail(String.format("rangePos %.2f in no-trade zone [%.2f, %.2f]",
                    rangePos, cfg.getNoTradeZoneMin(), cfg.getNoTradeZoneMax()), rangePos);
        }

        // ── Block: BULLISH but price too high in range ────────────────────────
        if (bias == Bias.BULLISH && rangePos > cfg.getLongZoneMax()) {
            return Result.fail(String.format("BULLISH but rangePos %.2f > longZoneMax %.2f",
                    rangePos, cfg.getLongZoneMax()), rangePos);
        }

        // ── Block: BEARISH but price too low in range ─────────────────────────
        if (bias == Bias.BEARISH && rangePos < cfg.getShortZoneMin()) {
            return Result.fail(String.format("BEARISH but rangePos %.2f < shortZoneMin %.2f",
                    rangePos, cfg.getShortZoneMin()), rangePos);
        }

        return Result.ok(String.format("rangePos=%.2f OK", rangePos), rangePos);
    }
}
