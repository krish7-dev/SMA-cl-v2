package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Modular exit evaluator — runs on every candle while in a position.
 *
 * ── Hold Zone (profit < holdZonePct) ────────────────────────────────────────
 *   Only P1 (SL) and P6d (dead-trade time kill) are active.
 *   All other signals are suppressed until profit clears the hold zone.
 *
 * ── Strong Trend Mode (TRENDING + peakPnl > trendStrongModeThresholdPct) ──
 *   Only P1, P2, and P5c (strong opposite signal) are active.
 *   Structure, score-floor, time, and no-hope exits are suppressed.
 *
 * Priority order (after hold-zone / strong-trend gates):
 *   P1   Hard Stop Loss           (always — fires inside bar-hold and hold zone)
 *   P2   Profit Lock / Trailing   (post bar-hold; only arms once profit ≥ holdZonePct)
 *   P3   First-Move Protection    (arms lock — no forced exit; disabled by default)
 *   P4   Structure Failure        (non-TRENDING + non-RANGING only)
 *   P5c  Bias Reversal            (TRENDING: score ≥ strongExitScore; RANGING/other: any flip)
 *   P6a  Time / No Improvement    (non-TRENDING + non-RANGING only)
 *   P6b  Time / Stagnation        (non-TRENDING + non-RANGING only)
 *   P6c  RANGING Time Limit       (RANGING only)
 *   P6d  Dead Trade               (any regime; fires from inside hold zone)
 *   P7   No-Hope                  (non-TRENDING + non-RANGING only)
 *
 * Removed:
 *   P5a  Score Collapsed  — score drop is not an exit signal
 *   P5b  Score Below Floor — score must NOT trigger exit under any condition
 */
@Slf4j
public class ExitEvaluator {

    // ── Signal ────────────────────────────────────────────────────────────────

    public enum DesiredSideHint { NONE, CE, PE }

    public static class ExitSignal {
        public final String          reason;
        public final double          exitPx;
        public final DesiredSideHint desiredSide;
        /** true = signal fires even inside the bar-based hold window */
        public final boolean         allowedInHold;

        ExitSignal(String reason, double exitPx, DesiredSideHint side, boolean allowedInHold) {
            this.reason        = reason;
            this.exitPx        = exitPx;
            this.desiredSide   = side;
            this.allowedInHold = allowedInHold;
        }
    }

    // ── Per-position state ────────────────────────────────────────────────────

    @Getter private double  peakPnlPct         = 0.0;
    @Getter private double  worstPnlPct        = 0.0;
    @Getter private double  profitLockFloor    = Double.NEGATIVE_INFINITY;
    @Getter private boolean everProfitable     = false;
    @Getter private int     barsWithoutNewHigh = 0;
    @Getter private int     barsNegative       = 0;
    /** True when the current pnl is below holdZonePct — only SL/dead-trade can exit. */
    @Getter private boolean inHoldZone         = false;
    /** True when TRENDING regime + peak pnl has cleared trendStrongModeThresholdPct. */
    @Getter private boolean inStrongTrendMode  = false;

    private double  entryScore          = 0.0;
    private double  entryOptionPrice    = 0.0;
    private boolean breakevenActivated  = false;

    private final Deque<CandleDto>                niftyWindow = new ArrayDeque<>();
    private final OptionsReplayRequest.ExitConfig ec;

    public ExitEvaluator(OptionsReplayRequest.ExitConfig ec) {
        this.ec = ec != null ? ec : new OptionsReplayRequest.ExitConfig();
    }

    // ── Reset on new entry ────────────────────────────────────────────────────

    public void onEntry(double entryScore, double entryOptionPrice) {
        this.entryScore         = entryScore;
        this.entryOptionPrice   = entryOptionPrice;
        this.peakPnlPct         = 0.0;
        this.worstPnlPct        = 0.0;
        this.profitLockFloor    = Double.NEGATIVE_INFINITY;
        this.everProfitable     = false;
        this.barsWithoutNewHigh = 0;
        this.barsNegative       = 0;
        this.inHoldZone         = true;   // always start in hold zone
        this.inStrongTrendMode  = false;
        this.breakevenActivated = false;
        this.niftyWindow.clear();
    }

    // ── Per-candle evaluation ─────────────────────────────────────────────────

    public ExitSignal evaluate(int barsInTrade,
                               double currentOptPx,
                               double currentScore,
                               NiftyDecisionResult.Bias confirmedBias,
                               OptionExecutionEngine.PositionState positionType,
                               CandleDto niftyCandle,
                               String regime) {

        if (!ec.isEnabled()) return null;

        boolean isTrending = "TRENDING".equals(regime);
        boolean isRanging  = "RANGING".equals(regime);

        double currentPnlPct = entryOptionPrice > 0
                ? (currentOptPx - entryOptionPrice) / entryOptionPrice * 100.0
                : 0.0;

        // Update observable mode flags (read by OptionExecutionEngine for SSE events)
        this.inHoldZone        = currentPnlPct < ec.getHoldZonePct();
        this.inStrongTrendMode = isTrending && peakPnlPct > ec.getTrendStrongModeThresholdPct();

        // ── Update rolling NIFTY window ───────────────────────────────────────
        if (niftyCandle != null) {
            niftyWindow.addLast(niftyCandle);
            while (niftyWindow.size() > ec.getStructureLookback()) {
                niftyWindow.removeFirst();
            }
        }

        // ── Track peak / worst / consecutive counters ─────────────────────────
        if (currentPnlPct > peakPnlPct) {
            peakPnlPct         = currentPnlPct;
            barsWithoutNewHigh = 0;
        } else {
            barsWithoutNewHigh++;
        }
        if (currentPnlPct < worstPnlPct) {
            worstPnlPct = currentPnlPct;
        }
        if (currentPnlPct > 0) {
            everProfitable = true;
            barsNegative   = 0;
        } else {
            barsNegative++;
        }

        // Always update ratchet so the floor is ready when hold zone is cleared
        updateProfitLock(currentPnlPct);

        // Activate breakeven protection once peak has reached the trigger threshold
        if (ec.isBreakevenProtectionEnabled() && !breakevenActivated
                && peakPnlPct >= ec.getBreakevenTriggerPct()) {
            breakevenActivated = true;
            log.info("[EXIT] Breakeven activated: favorableMovePct={}%",
                    String.format("%.2f", peakPnlPct));
        }

        double exitPx = currentOptPx;

        // ════════════════════════════════════════════════════════════════════
        // P1 — Hard Stop Loss  (always — fires inside bar-hold and hold zone)
        // ════════════════════════════════════════════════════════════════════
        if (ec.getHardStopPct() > 0 && currentPnlPct <= -ec.getHardStopPct()) {
            double slPx = entryOptionPrice * (1 - ec.getHardStopPct() / 100.0);
            log.debug("EXIT P1 HARD_STOP pnl={}% <= -{}%",
                    String.format("%.2f", currentPnlPct), ec.getHardStopPct());
            return applyBreakeven(new ExitSignal("HARD_STOP_LOSS", Math.min(exitPx, slPx), DesiredSideHint.NONE, true));
        }

        // ════════════════════════════════════════════════════════════════════
        // P2 — Profit Lock / Trailing
        //      Only fires once profit has previously cleared holdZonePct,
        //      which guarantees the floor was ratcheted from a real gain.
        // ════════════════════════════════════════════════════════════════════
        if (profitLockFloor > Double.NEGATIVE_INFINITY && currentPnlPct < profitLockFloor) {
            log.debug("EXIT P2 PROFIT_LOCK_HIT pnl={}% < floor={}%",
                    String.format("%.2f", currentPnlPct), String.format("%.2f", profitLockFloor));
            return applyBreakeven(new ExitSignal("PROFIT_LOCK_HIT", exitPx, DesiredSideHint.NONE, false));
        }

        // ════════════════════════════════════════════════════════════════════
        // HOLD ZONE — profit below holdZonePct: hold unless dead-trade kill
        //
        // This prevents all signal-based exits until the trade has proven
        // itself with a meaningful gain.  The only escape before +holdZonePct
        // is P1 (SL) above or P6d (dead-trade time kill) below.
        // ════════════════════════════════════════════════════════════════════
        boolean inHoldZone = currentPnlPct < ec.getHoldZonePct();
        if (inHoldZone) {
            // P6d inside hold zone — eject a dead trade that never moved
            if (ec.getMaxBarsDeadTrade() > 0
                    && barsInTrade > ec.getMaxBarsDeadTrade()
                    && currentPnlPct < ec.getDeadTradePnlPct()) {
                log.debug("EXIT P6d DEAD_TRADE_IN_HOLD_ZONE bars={} pnl={}% < {}%",
                        barsInTrade,
                        String.format("%.2f", currentPnlPct),
                        ec.getDeadTradePnlPct());
                return applyBreakeven(new ExitSignal("DEAD_TRADE", exitPx, DesiredSideHint.NONE, false));
            }
            log.trace("HOLD_ZONE pnl={}% < {}% — waiting for zone break",
                    String.format("%.2f", currentPnlPct), ec.getHoldZonePct());
            return null;
        }

        // ════════════════════════════════════════════════════════════════════
        // P3 — First-Move Protection  (arms lock, no exit)
        //      Disabled by default (firstMoveBars=0) — hold zone supersedes it.
        // ════════════════════════════════════════════════════════════════════
        if (ec.getFirstMoveBars() > 0 && barsInTrade <= ec.getFirstMoveBars() && everProfitable) {
            double targetFloor = ec.getFirstMoveLockPct();
            if (profitLockFloor < targetFloor) {
                profitLockFloor = targetFloor;
                log.debug("EXIT P3 FIRST_MOVE_LOCK armed floor={}% at bar={}",
                        String.format("%.2f", targetFloor), barsInTrade);
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // STRONG TREND MODE — TRENDING + peak has cleared trendStrongModeThresholdPct
        //
        // In this mode only the trailing stop (P2, already checked) and a
        // strong opposite confirmed bias (P5c with score ≥ strongExitScore)
        // are allowed to exit.  All other signals are suppressed.
        // ════════════════════════════════════════════════════════════════════
        boolean inStrongTrendMode = isTrending
                && peakPnlPct > ec.getTrendStrongModeThresholdPct();

        if (inStrongTrendMode) {
            if (ec.isBiasExitEnabled() && currentScore >= ec.getStrongExitScore()) {
                if (positionType == OptionExecutionEngine.PositionState.LONG_CALL
                        && confirmedBias == NiftyDecisionResult.Bias.BEARISH) {
                    log.debug("EXIT P5c STRONG_TREND_BIAS_REVERSAL LONG_CALL bearish score={}",
                            String.format("%.1f", currentScore));
                    return applyBreakeven(new ExitSignal("BIAS_REVERSAL_STRONG", exitPx, DesiredSideHint.PE, false));
                }
                if (positionType == OptionExecutionEngine.PositionState.LONG_PUT
                        && confirmedBias == NiftyDecisionResult.Bias.BULLISH) {
                    log.debug("EXIT P5c STRONG_TREND_BIAS_REVERSAL LONG_PUT bullish score={}",
                            String.format("%.1f", currentScore));
                    return applyBreakeven(new ExitSignal("BIAS_REVERSAL_STRONG", exitPx, DesiredSideHint.CE, false));
                }
            }
            log.trace("STRONG_TREND_MODE — suppressing all non-trail exits pnl={}%",
                    String.format("%.2f", currentPnlPct));
            return null;
        }

        // ── Full exit system (profit ≥ holdZonePct, not in strong trend mode) ─

        // ════════════════════════════════════════════════════════════════════
        // P4 — Structure Failure (NIFTY close vs rolling high/low)
        //      Skipped in RANGING (use time limit instead of structure).
        // ════════════════════════════════════════════════════════════════════
        if (!isRanging
                && niftyWindow.size() >= Math.min(3, ec.getStructureLookback())
                && niftyCandle != null && niftyCandle.close() != null) {
            double niftyClose = niftyCandle.close().doubleValue();

            if (positionType == OptionExecutionEngine.PositionState.LONG_CALL) {
                double support = niftyWindow.stream()
                        .filter(c -> c.low() != null)
                        .mapToDouble(c -> c.low().doubleValue())
                        .min().orElse(Double.MIN_VALUE);
                if (niftyClose < support) {
                    log.debug("EXIT P4 STRUCTURE_FAILURE_SUPPORT close={} < support={}",
                            String.format("%.2f", niftyClose), String.format("%.2f", support));
                    return applyBreakeven(new ExitSignal("STRUCTURE_FAILURE_SUPPORT", exitPx, DesiredSideHint.NONE, false));
                }
            }
            if (positionType == OptionExecutionEngine.PositionState.LONG_PUT) {
                double resistance = niftyWindow.stream()
                        .filter(c -> c.high() != null)
                        .mapToDouble(c -> c.high().doubleValue())
                        .max().orElse(Double.MAX_VALUE);
                if (niftyClose > resistance) {
                    log.debug("EXIT P4 STRUCTURE_FAILURE_RESISTANCE close={} > resistance={}",
                            String.format("%.2f", niftyClose), String.format("%.2f", resistance));
                    return applyBreakeven(new ExitSignal("STRUCTURE_FAILURE_RESISTANCE", exitPx, DesiredSideHint.NONE, false));
                }
            }
        }

        // P5b — REMOVED: Score must NOT trigger exit under any condition.

        // ════════════════════════════════════════════════════════════════════
        // P5c — Confirmed Bias Reversal
        //        TRENDING (not in strong mode): require score ≥ strongExitScore.
        //        RANGING / other: fire on any confirmed flip.
        // ════════════════════════════════════════════════════════════════════
        if (ec.isBiasExitEnabled()) {
            boolean strongEnough = !isTrending || currentScore >= ec.getStrongExitScore();
            if (strongEnough) {
                if (positionType == OptionExecutionEngine.PositionState.LONG_CALL
                        && confirmedBias == NiftyDecisionResult.Bias.BEARISH) {
                    log.debug("EXIT P5c BIAS_REVERSAL LONG_CALL bearish score={}",
                            String.format("%.1f", currentScore));
                    return applyBreakeven(new ExitSignal("BIAS_REVERSAL", exitPx, DesiredSideHint.PE, false));
                }
                if (positionType == OptionExecutionEngine.PositionState.LONG_PUT
                        && confirmedBias == NiftyDecisionResult.Bias.BULLISH) {
                    log.debug("EXIT P5c BIAS_REVERSAL LONG_PUT bullish score={}",
                            String.format("%.1f", currentScore));
                    return applyBreakeven(new ExitSignal("BIAS_REVERSAL", exitPx, DesiredSideHint.CE, false));
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // P6a — Time: No Improvement (never profitable)
        //        Non-TRENDING and non-RANGING only.
        //        RANGING uses P6c (time limit) instead.
        // ════════════════════════════════════════════════════════════════════
        if (!isTrending && !isRanging
                && ec.getMaxBarsNoImprovement() > 0
                && !everProfitable
                && barsInTrade >= ec.getMaxBarsNoImprovement()) {
            log.debug("EXIT P6a TIME_NO_IMPROVEMENT bars={}", barsInTrade);
            return applyBreakeven(new ExitSignal("TIME_NO_IMPROVEMENT", exitPx, DesiredSideHint.NONE, false));
        }

        // ════════════════════════════════════════════════════════════════════
        // P6b — Time: Stagnation (was profitable, peak stale)
        //        Non-TRENDING and non-RANGING only.
        // ════════════════════════════════════════════════════════════════════
        if (!isTrending && !isRanging
                && ec.getStagnationBars() > 0
                && everProfitable
                && barsWithoutNewHigh >= ec.getStagnationBars()
                && currentPnlPct > 0) {
            log.debug("EXIT P6b TIME_STAGNATION noNewHighBars={} pnl={}%",
                    barsWithoutNewHigh, String.format("%.2f", currentPnlPct));
            return applyBreakeven(new ExitSignal("TIME_STAGNATION", exitPx, DesiredSideHint.NONE, false));
        }

        // ════════════════════════════════════════════════════════════════════
        // P6c — RANGING Time Limit
        // ════════════════════════════════════════════════════════════════════
        if (isRanging && ec.getMaxBarsRanging() > 0 && barsInTrade >= ec.getMaxBarsRanging()) {
            log.debug("EXIT P6c RANGING_TIME_LIMIT bars={} >= {}", barsInTrade, ec.getMaxBarsRanging());
            return applyBreakeven(new ExitSignal("RANGING_TIME_LIMIT", exitPx, DesiredSideHint.NONE, false));
        }

        // ════════════════════════════════════════════════════════════════════
        // P6d — Dead Trade (time kill — any regime, any profit level)
        //        Safety net for trades that stagnate above the hold zone.
        // ════════════════════════════════════════════════════════════════════
        if (ec.getMaxBarsDeadTrade() > 0
                && barsInTrade > ec.getMaxBarsDeadTrade()
                && currentPnlPct < ec.getDeadTradePnlPct()) {
            log.debug("EXIT P6d DEAD_TRADE bars={} pnl={}% < {}%",
                    barsInTrade, String.format("%.2f", currentPnlPct), ec.getDeadTradePnlPct());
            return applyBreakeven(new ExitSignal("DEAD_TRADE", exitPx, DesiredSideHint.NONE, false));
        }

        // ════════════════════════════════════════════════════════════════════
        // P7 — No-Hope (sustained loss)
        //        Non-TRENDING and non-RANGING only.
        //        RANGING: SL (P1) handles losses; no-hope would exit too early.
        // ════════════════════════════════════════════════════════════════════
        if (!isTrending && !isRanging
                && ec.getNoHopeThresholdPct() > 0
                && currentPnlPct <= -ec.getNoHopeThresholdPct()
                && barsNegative >= ec.getNoHopeBars()) {
            log.debug("EXIT P7 NO_HOPE pnl={}% barsNeg={}",
                    String.format("%.2f", currentPnlPct), barsNegative);
            return applyBreakeven(new ExitSignal("NO_HOPE", exitPx, DesiredSideHint.NONE, false));
        }

        return null; // HOLD
    }

    // ── Breakeven protection override ────────────────────────────────────────

    private ExitSignal applyBreakeven(ExitSignal signal) {
        if (signal == null || !breakevenActivated) return signal;
        double floor = entryOptionPrice * (1.0 + ec.getBreakevenOffsetPct() / 100.0);
        if (signal.exitPx < floor) {
            log.info("[EXIT] Breakeven protection applied: originalExitPrice={}, adjustedExitPrice={}, reason={}",
                    String.format("%.2f", signal.exitPx), String.format("%.2f", floor), signal.reason);
            return new ExitSignal(signal.reason, floor, signal.desiredSide, signal.allowedInHold);
        }
        return signal;
    }

    // ── Profit lock ratchet (one-way — never decreases) ──────────────────────

    private void updateProfitLock(double currentPnlPct) {
        double newFloor;
        if (ec.getTrailTriggerPct() > 0 && currentPnlPct >= ec.getTrailTriggerPct()) {
            newFloor = peakPnlPct * ec.getTrailFactor();
        } else if (ec.getLock2TriggerPct() > 0 && currentPnlPct >= ec.getLock2TriggerPct()) {
            newFloor = ec.getLock2FloorPct();
        } else if (ec.getLock1TriggerPct() > 0 && currentPnlPct >= ec.getLock1TriggerPct()) {
            newFloor = ec.getLock1FloorPct();
        } else {
            return;
        }
        if (newFloor > profitLockFloor) {
            log.debug("PROFIT_LOCK ratchet {} → {}",
                    String.format("%.2f", profitLockFloor), String.format("%.2f", newFloor));
            profitLockFloor = newFloor;
        }
    }
}
