package com.sma.strategyengine.service;

import java.util.Arrays;

/**
 * Detects market regime for each candle using ADX (trend strength) and ATR (volatility).
 *
 * Regimes:
 *   TRENDING    — ADX above threshold (strong directional movement)
 *   VOLATILE    — ATR/price% above threshold (large swings, no clear direction)
 *   COMPRESSION — ATR/price% below threshold (tight range, low volatility / squeeze)
 *   RANGING     — everything else (moderate ATR, low ADX)
 *
 * Call computeAll() once before the backtest loop to get a regime per candle index.
 * Indices before the warmup period return RANGING (not enough data).
 */
public final class MarketRegimeDetector {

    public enum Regime { TRENDING, RANGING, VOLATILE, COMPRESSION }

    private MarketRegimeDetector() {}

    /**
     * Pre-compute regime for every candle.
     *
     * @param highs                 candle high prices
     * @param lows                  candle low prices
     * @param closes                candle close prices
     * @param adxPeriod             ADX period (default 14)
     * @param atrPeriod             ATR period (default 14)
     * @param adxTrendThreshold     ADX > this → TRENDING (default 25)
     * @param atrVolatilePct        ATR/close% > this → VOLATILE (default 2.0)
     * @param atrCompressionPct     ATR/close% < this → COMPRESSION (default 0.5)
     * @return array of same length as inputs, RANGING where data insufficient
     */
    public static Regime[] computeAll(double[] highs, double[] lows, double[] closes,
                                      int adxPeriod, int atrPeriod,
                                      double adxTrendThreshold,
                                      double atrVolatilePct,
                                      double atrCompressionPct) {
        int n = closes.length;
        Regime[] regimes = new Regime[n];
        Arrays.fill(regimes, Regime.RANGING);

        double[] atr = computeATR(highs, lows, closes, atrPeriod);
        double[] adx = computeADX(highs, lows, closes, adxPeriod);

        // Warmup: need at least 2*adxPeriod bars for ADX to stabilise
        int warmup = adxPeriod * 2;

        for (int i = 0; i < n; i++) {
            if (i < warmup || Double.isNaN(atr[i]) || Double.isNaN(adx[i])) continue;
            double atrPct = closes[i] > 0 ? (atr[i] / closes[i]) * 100.0 : 0;

            if (adx[i] > adxTrendThreshold)     regimes[i] = Regime.TRENDING;
            else if (atrPct > atrVolatilePct)    regimes[i] = Regime.VOLATILE;
            else if (atrPct < atrCompressionPct) regimes[i] = Regime.COMPRESSION;
            else                                 regimes[i] = Regime.RANGING;
        }
        return regimes;
    }

    // ─── ATR (Wilder's smoothing) ─────────────────────────────────────────────

    private static double[] computeATR(double[] H, double[] L, double[] C, int period) {
        int n = C.length;
        double[] atr = new double[n];
        Arrays.fill(atr, Double.NaN);
        if (n < period + 1) return atr;

        double[] tr = new double[n];
        tr[0] = H[0] - L[0];
        for (int i = 1; i < n; i++) {
            tr[i] = Math.max(H[i] - L[i],
                    Math.max(Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
        }

        // Initial ATR = simple average of first `period` TRs
        double sum = 0;
        for (int i = 0; i < period; i++) sum += tr[i];
        atr[period - 1] = sum / period;

        // Subsequent: Wilder's smoothing
        for (int i = period; i < n; i++) {
            atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
        }
        return atr;
    }

    // ─── ADX (Wilder's) ───────────────────────────────────────────────────────

    private static double[] computeADX(double[] H, double[] L, double[] C, int period) {
        int n = C.length;
        double[] adx = new double[n];
        Arrays.fill(adx, Double.NaN);
        if (n < period * 2 + 1) return adx;

        double[] tr  = new double[n];
        double[] pdm = new double[n];
        double[] mdm = new double[n];
        tr[0] = H[0] - L[0];

        for (int i = 1; i < n; i++) {
            tr[i]  = Math.max(H[i] - L[i],
                     Math.max(Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
            double up   = H[i] - H[i - 1];
            double down = L[i - 1] - L[i];
            pdm[i] = (up > down && up > 0)   ? up   : 0;
            mdm[i] = (down > up && down > 0) ? down : 0;
        }

        // Wilder's initial sums (bars 1..period)
        double sTR = 0, sPDM = 0, sMDM = 0;
        for (int i = 1; i <= period; i++) { sTR += tr[i]; sPDM += pdm[i]; sMDM += mdm[i]; }

        // Compute DX from period onwards
        double[] dx = new double[n];
        Arrays.fill(dx, Double.NaN);
        dx[period] = calcDX(sTR, sPDM, sMDM);

        for (int i = period + 1; i < n; i++) {
            sTR  = sTR  - sTR  / period + tr[i];
            sPDM = sPDM - sPDM / period + pdm[i];
            sMDM = sMDM - sMDM / period + mdm[i];
            dx[i] = calcDX(sTR, sPDM, sMDM);
        }

        // ADX = Wilder's average of DX (starts at bar 2*period)
        double sumDX = 0;
        int    validDX = 0;
        for (int i = period; i < period * 2; i++) {
            if (!Double.isNaN(dx[i])) { sumDX += dx[i]; validDX++; }
        }
        if (validDX == 0) return adx;
        adx[period * 2 - 1] = sumDX / validDX;

        for (int i = period * 2; i < n; i++) {
            if (!Double.isNaN(dx[i])) {
                adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
            } else {
                adx[i] = adx[i - 1];
            }
        }
        return adx;
    }

    private static double calcDX(double sTR, double sPDM, double sMDM) {
        if (sTR <= 0) return 0;
        double pdi = 100.0 * sPDM / sTR;
        double mdi = 100.0 * sMDM / sTR;
        double sum = pdi + mdi;
        return sum <= 0 ? 0 : 100.0 * Math.abs(pdi - mdi) / sum;
    }
}
