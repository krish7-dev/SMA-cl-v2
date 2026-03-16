package com.sma.strategyengine.service;

import lombok.Builder;
import lombok.Value;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;

/**
 * Per-instrument strategy scorer — Java equivalent of the UI-side LocalStrategyScorer.
 *
 * <p>Computes a quality score (0–100) for a strategy signal given recent price
 * history and market regime. The score reflects four positive components:
 * <ul>
 *   <li>trendStrength — ADX-proxy (DX from consecutive directional moves)</li>
 *   <li>volatility    — normalised ATR% (good range to trade, not too wild)</li>
 *   <li>momentum      — direction-aware ROC over last 5 closes</li>
 *   <li>confidence    — regime-match bonus</li>
 * </ul>
 * … and five quality <em>penalties</em> that can reduce the base score:
 * <ul>
 *   <li>reversalPenalty          — recent price sign flips in last 5 close diffs</li>
 *   <li>overextensionPenalty     — distance from VWAP proxy</li>
 *   <li>sameColorPenalty         — 3+ consecutive same-direction candles</li>
 *   <li>instrumentMismatchPenalty — slow strategies on OPTIONS</li>
 *   <li>volatileOptionPenalty    — VOLATILE regime for OPTIONS</li>
 * </ul>
 *
 * <p>Maintain one instance per instrument token; call {@link #push(double, double, double, double)}
 * on every candle and {@link #score(String, boolean, String, String)} only on signal candles.
 */
public class StrategyScorer {

    // ── Per-strategy weight maps ─────────────────────────────────────────────
    // Columns: trend, volatility, momentum, confidence
    private static final Map<String, double[]> WEIGHTS = Map.of(
            "SMA_CROSSOVER",        new double[]{0.45, 0.10, 0.30, 0.15},
            "EMA_CROSSOVER",        new double[]{0.40, 0.15, 0.30, 0.15},
            "MACD",                 new double[]{0.35, 0.20, 0.30, 0.15},
            "RSI",                  new double[]{0.20, 0.35, 0.25, 0.20},
            "RSI_REVERSAL",         new double[]{0.15, 0.40, 0.20, 0.25},
            "BREAKOUT",             new double[]{0.40, 0.30, 0.15, 0.15},
            "BOLLINGER_REVERSION",  new double[]{0.10, 0.45, 0.20, 0.25},
            "VWAP_PULLBACK",        new double[]{0.30, 0.25, 0.25, 0.20},
            "LIQUIDITY_SWEEP",      new double[]{0.25, 0.35, 0.20, 0.20}
    );
    private static final double[] DEFAULT_WEIGHTS = {0.30, 0.25, 0.25, 0.20};

    // ── Instrument-mismatch penalties (strategy → instrument-type → penalty) ─
    // Slow/trend strategies are less suited for fast-moving options.
    private static final Map<String, Map<String, Double>> MISMATCH = Map.of(
            "SMA_CROSSOVER",  Map.of("OPTION", 30.0),
            "EMA_CROSSOVER",  Map.of("OPTION", 25.0),
            "MACD",           Map.of("OPTION", 15.0),
            "RSI",            Map.of("OPTION", 10.0),
            "RSI_REVERSAL",   Map.of("OPTION", 15.0),
            "BREAKOUT",       Map.of("OPTION", 20.0)
    );

    // ── Rolling window ───────────────────────────────────────────────────────
    private static final int MAX_HISTORY = 100;

    private final Deque<double[]> history = new ArrayDeque<>();  // [open, high, low, close]

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Feed one completed candle into the rolling window.
     * Must be called for every candle (not only signal candles) to keep the window fresh.
     */
    public void push(double open, double high, double low, double close) {
        history.addLast(new double[]{open, high, low, close});
        if (history.size() > MAX_HISTORY) history.removeFirst();
    }

    /**
     * Compute a quality score for the given strategy signal.
     *
     * @param strategyType  strategy enum name (e.g. "SMA_CROSSOVER")
     * @param isBuy         true = BUY signal, false = SELL signal
     * @param regime        regime name ("TRENDING" | "RANGING" | "VOLATILE" | "COMPRESSION"); may be null
     * @param instrType     "STOCK" or "OPTION"
     * @return              {@link ScoreResult} with total and breakdown
     */
    public ScoreResult score(String strategyType, boolean isBuy,
                             String regime, String instrType) {
        if (history.size() < 5) {
            return ScoreResult.zero(strategyType);
        }

        double[] wt = WEIGHTS.getOrDefault(strategyType, DEFAULT_WEIGHTS);

        double trend      = trendStrength();
        double vol        = volatility();
        double mom        = momentum(isBuy);
        double confidence = regimeConfidence(strategyType, regime);

        double base = wt[0] * trend + wt[1] * vol + wt[2] * mom + wt[3] * confidence;

        double revPenalty     = reversalPenalty();
        double extPenalty     = overextensionPenalty(isBuy);
        double sameClrPenalty = sameColorPenalty(isBuy);
        double mismatchPen    = mismatchPenalty(strategyType, instrType);
        double volOptPenalty  = volatileOptionPenalty(regime, instrType);

        double totalPenalty = revPenalty + extPenalty + sameClrPenalty + mismatchPen + volOptPenalty;
        double total = Math.max(0.0, base - totalPenalty);

        return ScoreResult.builder()
                .strategyType(strategyType)
                .total(total)
                .baseScore(base)
                .trendStrength(trend)
                .volatilityScore(vol)
                .momentumScore(mom)
                .confidenceScore(confidence)
                .reversalPenalty(revPenalty)
                .overextensionPenalty(extPenalty)
                .sameColorPenalty(sameClrPenalty)
                .instrumentMismatchPenalty(mismatchPen)
                .volatileOptionPenalty(volOptPenalty)
                .totalPenalty(totalPenalty)
                .build();
    }

    // ── Positive components ──────────────────────────────────────────────────

    /** ADX-proxy: fraction of last 14 candle pairs that moved directionally. */
    private double trendStrength() {
        double[] closes = closes();
        int n = Math.min(closes.length, 14);
        if (n < 2) return 50.0;
        int directional = 0;
        for (int i = closes.length - n; i < closes.length - 1; i++) {
            double d1 = closes[i + 1] - closes[i];
            double d0 = i > 0 ? closes[i] - closes[i - 1] : d1;
            if ((d1 > 0 && d0 > 0) || (d1 < 0 && d0 < 0)) directional++;
        }
        double adxProxy = (double) directional / (n - 1) * 100.0;
        if (adxProxy >= 70) return 90.0;
        if (adxProxy >= 50) return 65.0;
        if (adxProxy >= 35) return 45.0;
        if (adxProxy >= 20) return 25.0;
        return 10.0;
    }

    /**
     * ATR% volatility score — optimal middle range scores highest,
     * extremes (near-zero or very high) score lower.
     */
    private double volatility() {
        double[] H = highs(), L = lows(), C = closes();
        int n = Math.min(H.length, 14);
        if (n < 2) return 50.0;
        int off = H.length - n;
        double atrSum = 0;
        for (int i = off; i < H.length; i++) {
            double prevC = i > 0 ? C[i - 1] : C[i];
            double tr = Math.max(H[i] - L[i], Math.max(Math.abs(H[i] - prevC), Math.abs(L[i] - prevC)));
            atrSum += tr;
        }
        double atr = atrSum / n;
        double lastC = C[C.length - 1];
        double atrPct = lastC > 0 ? (atr / lastC) * 100.0 : 0;
        if (atrPct > 5.0) return 20.0;
        if (atrPct > 3.0) return 50.0;
        if (atrPct > 1.5) return 80.0;
        if (atrPct > 0.5) return 60.0;
        return 20.0;
    }

    /** Direction-aware Rate-of-Change over last 5 closes (0–100). */
    private double momentum(boolean isBuy) {
        double[] closes = closes();
        if (closes.length < 5) return 50.0;
        double base5 = closes[closes.length - 5];
        double last  = closes[closes.length - 1];
        if (base5 <= 0) return 50.0;
        double roc = ((last - base5) / base5) * 100.0;
        double absRoc = Math.abs(roc);
        double score;
        if (absRoc > 3.0)      score = 90.0;
        else if (absRoc > 1.5) score = 70.0;
        else if (absRoc > 0.5) score = 50.0;
        else                   score = 20.0;
        // Align direction with signal
        boolean momentumBullish = roc > 0;
        if ((isBuy && !momentumBullish) || (!isBuy && momentumBullish)) {
            score = Math.max(10.0, score - 30.0);
        }
        return score;
    }

    /** Regime confidence bonus — how well does the current regime suit the strategy? */
    private double regimeConfidence(String strategyType, String regime) {
        if (regime == null) return 50.0;
        return switch (regime) {
            case "TRENDING" -> switch (strategyType) {
                case "SMA_CROSSOVER", "EMA_CROSSOVER", "MACD", "BREAKOUT" -> 90.0;
                case "VWAP_PULLBACK", "LIQUIDITY_SWEEP" -> 60.0;
                default -> 30.0;
            };
            case "RANGING" -> switch (strategyType) {
                case "RSI", "RSI_REVERSAL", "BOLLINGER_REVERSION", "VWAP_PULLBACK" -> 85.0;
                case "LIQUIDITY_SWEEP" -> 65.0;
                default -> 25.0;
            };
            case "VOLATILE" -> switch (strategyType) {
                case "BOLLINGER_REVERSION", "RSI_REVERSAL", "LIQUIDITY_SWEEP" -> 55.0;
                default -> 15.0;
            };
            case "COMPRESSION" -> switch (strategyType) {
                case "BREAKOUT" -> 80.0;
                case "VWAP_PULLBACK", "BOLLINGER_REVERSION" -> 55.0;
                default -> 30.0;
            };
            default -> 50.0;
        };
    }

    // ── Quality penalties ────────────────────────────────────────────────────

    /**
     * Reversal penalty: how many sign flips exist in the last 5 close diffs?
     * More flips = choppier = lower quality entry.
     */
    private double reversalPenalty() {
        double[] closes = closes();
        if (closes.length < 6) return 0.0;
        int flips = 0;
        double prevDiff = closes[closes.length - 5] - closes[closes.length - 6];
        for (int i = closes.length - 4; i < closes.length; i++) {
            double diff = closes[i] - closes[i - 1];
            if ((diff > 0 && prevDiff < 0) || (diff < 0 && prevDiff > 0)) flips++;
            prevDiff = diff;
        }
        if (flips >= 4) return 25.0;
        if (flips >= 3) return 20.0;
        if (flips >= 2) return 12.0;
        return 0.0;
    }

    /**
     * Overextension penalty: how far is the current close from the VWAP proxy
     * (equal-weighted typical-price mean over last 50 candles)?
     */
    private double overextensionPenalty(boolean isBuy) {
        double[][] hist = historyArray();
        if (hist.length < 10) return 0.0;
        int n = Math.min(hist.length, 50);
        double sum = 0;
        for (int i = hist.length - n; i < hist.length; i++) {
            double tp = (hist[i][1] + hist[i][2] + hist[i][3]) / 3.0;  // (H+L+C)/3
            sum += tp;
        }
        double vwap = sum / n;
        double last = hist[hist.length - 1][3];
        if (vwap <= 0) return 0.0;
        double pctFromVwap = ((last - vwap) / vwap) * 100.0;

        // LONG entry: penalise if price is far ABOVE VWAP (overextended upward)
        // SHORT entry: penalise if price is far BELOW VWAP (overextended downward)
        double ext = isBuy ? pctFromVwap : -pctFromVwap;
        if (ext > 3.0) return 30.0;
        if (ext > 2.0) return 22.0;
        if (ext > 1.5) return 15.0;
        if (ext > 1.0) return 8.0;
        return 0.0;
    }

    /**
     * Same-color candle penalty: 3+ consecutive candles in the same direction
     * suggests exhaustion / late entry.
     */
    private double sameColorPenalty(boolean isBuy) {
        double[][] hist = historyArray();
        if (hist.length < 3) return 0.0;
        int streak = 0;
        for (int i = hist.length - 1; i >= Math.max(0, hist.length - 5); i--) {
            double open  = hist[i][0];
            double close = hist[i][3];
            boolean bullish = close > open;
            if ((isBuy && bullish) || (!isBuy && !bullish)) streak++;
            else break;
        }
        if (streak >= 5) return 30.0;
        if (streak >= 4) return 20.0;
        if (streak >= 3) return 12.0;
        return 0.0;
    }

    /** Penalty for slow/trend strategies used on fast-moving options. */
    private double mismatchPenalty(String strategyType, String instrType) {
        if (instrType == null) return 0.0;
        Map<String, Double> byType = MISMATCH.get(strategyType);
        if (byType == null) return 0.0;
        return byType.getOrDefault(instrType.toUpperCase(), 0.0);
    }

    /** Heavy penalty when trading options in a VOLATILE regime. */
    private double volatileOptionPenalty(String regime, String instrType) {
        if ("VOLATILE".equals(regime) && "OPTION".equalsIgnoreCase(instrType)) {
            return 35.0;
        }
        return 0.0;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private double[] closes() {
        double[][] hist = historyArray();
        double[] c = new double[hist.length];
        for (int i = 0; i < hist.length; i++) c[i] = hist[i][3];
        return c;
    }

    private double[] highs() {
        double[][] hist = historyArray();
        double[] h = new double[hist.length];
        for (int i = 0; i < hist.length; i++) h[i] = hist[i][1];
        return h;
    }

    private double[] lows() {
        double[][] hist = historyArray();
        double[] l = new double[hist.length];
        for (int i = 0; i < hist.length; i++) l[i] = hist[i][2];
        return l;
    }

    private double[][] historyArray() {
        return history.toArray(new double[0][]);
    }

    // ── Result type ──────────────────────────────────────────────────────────

    @Value
    @Builder
    public static class ScoreResult {
        String strategyType;
        double total;
        double baseScore;
        double trendStrength;
        double volatilityScore;
        double momentumScore;
        double confidenceScore;
        double reversalPenalty;
        double overextensionPenalty;
        double sameColorPenalty;
        double instrumentMismatchPenalty;
        double volatileOptionPenalty;
        double totalPenalty;

        public static ScoreResult zero(String strategyType) {
            return ScoreResult.builder()
                    .strategyType(strategyType)
                    .total(0.0).baseScore(0.0)
                    .trendStrength(0).volatilityScore(0).momentumScore(0).confidenceScore(0)
                    .reversalPenalty(0).overextensionPenalty(0).sameColorPenalty(0)
                    .instrumentMismatchPenalty(0).volatileOptionPenalty(0).totalPenalty(0)
                    .build();
        }
    }
}
