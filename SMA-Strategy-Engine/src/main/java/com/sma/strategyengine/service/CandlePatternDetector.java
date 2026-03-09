package com.sma.strategyengine.service;

import java.util.ArrayList;
import java.util.List;

/**
 * Detects Japanese candlestick patterns from OHLC data.
 *
 * Returns a list of all patterns present on the current candle given
 * up to two prior candles for multi-candle pattern recognition.
 *
 * Detected pattern names:
 *   HAMMER              — single-candle bullish reversal (long lower wick)
 *   SHOOTING_STAR       — single-candle bearish reversal (long upper wick)
 *   DOJI                — tiny body (≤5% of range), indecision
 *   DOJI_BULLISH        — doji following a bearish candle (bullish context)
 *   DOJI_BEARISH        — doji following a bullish candle (bearish context)
 *   BULLISH_ENGULFING   — 2-candle: current bullish body engulfs prior bearish body
 *   BEARISH_ENGULFING   — 2-candle: current bearish body engulfs prior bullish body
 *   MORNING_STAR        — 3-candle bullish reversal
 *   EVENING_STAR        — 3-candle bearish reversal
 */
public final class CandlePatternDetector {

    private CandlePatternDetector() {}

    /**
     * Detects all candlestick patterns for the current candle.
     *
     * @param prev2         two candles ago as [open, high, low, close], or null
     * @param prev1         one candle ago  as [open, high, low, close], or null
     * @param open          current candle open
     * @param high          current candle high
     * @param low           current candle low
     * @param close         current candle close
     * @param minWickRatio  wick must be at least this multiple of body (default 2.0)
     * @param maxBodyPct    body / range must be ≤ this for hammer/star detection (default 0.35)
     * @return list of detected pattern names (empty if none)
     */
    public static List<String> detect(double[] prev2, double[] prev1,
                                      double open, double high, double low, double close,
                                      double minWickRatio, double maxBodyPct) {
        List<String> patterns = new ArrayList<>();

        double range = high - low;
        if (range < 1e-9) return patterns;

        double body      = Math.abs(close - open);
        double bodyPct   = body / range;
        double lowerWick = Math.min(open, close) - low;
        double upperWick = high - Math.max(open, close);

        // ── Single-candle: Hammer ─────────────────────────────────────────────
        if (bodyPct <= maxBodyPct
                && (body < 1e-9 ? lowerWick > 0 : lowerWick >= minWickRatio * body)
                && upperWick <= lowerWick * 0.5 + 1e-9) {
            patterns.add("HAMMER");
        }

        // ── Single-candle: Shooting Star ─────────────────────────────────────
        if (bodyPct <= maxBodyPct
                && (body < 1e-9 ? upperWick > 0 : upperWick >= minWickRatio * body)
                && lowerWick <= upperWick * 0.5 + 1e-9) {
            patterns.add("SHOOTING_STAR");
        }

        // ── Single-candle: Doji ───────────────────────────────────────────────
        boolean isDoji = bodyPct <= 0.05;
        if (isDoji) {
            patterns.add("DOJI");
        }

        // ── Two-candle patterns ───────────────────────────────────────────────
        if (prev1 != null) {
            double p1Open  = prev1[0];
            double p1Close = prev1[3];

            // Doji with direction context
            if (isDoji) {
                if (p1Close < p1Open) patterns.add("DOJI_BULLISH");   // after bearish → bullish signal
                else if (p1Close > p1Open) patterns.add("DOJI_BEARISH"); // after bullish → bearish signal
            }

            // Bullish Engulfing
            if (p1Close < p1Open && close > open
                    && open <= p1Close && close >= p1Open) {
                patterns.add("BULLISH_ENGULFING");
            }

            // Bearish Engulfing
            if (p1Close > p1Open && close < open
                    && open >= p1Close && close <= p1Open) {
                patterns.add("BEARISH_ENGULFING");
            }
        }

        // ── Three-candle patterns ─────────────────────────────────────────────
        if (prev2 != null && prev1 != null) {
            double p2Open  = prev2[0];
            double p2Close = prev2[3];
            double p1Open  = prev1[0];
            double p1High  = prev1[1];
            double p1Low   = prev1[2];
            double p1Close = prev1[3];

            double p1Range = p1High - p1Low;
            double p1Body  = Math.abs(p1Close - p1Open);
            boolean p1Small = p1Range < 1e-9 || (p1Body / p1Range) <= maxBodyPct;

            double midpoint = (p2Open + p2Close) / 2.0;

            // Morning Star: bearish → small star → bullish above midpoint
            if (p2Close < p2Open && p1Small && close > open && close > midpoint) {
                patterns.add("MORNING_STAR");
            }

            // Evening Star: bullish → small star → bearish below midpoint
            if (p2Close > p2Open && p1Small && close < open && close < midpoint) {
                patterns.add("EVENING_STAR");
            }
        }

        return patterns;
    }
}
