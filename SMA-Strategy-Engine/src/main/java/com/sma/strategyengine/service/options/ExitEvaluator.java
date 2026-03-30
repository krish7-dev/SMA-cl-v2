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
 * Priority order:
 *   P1  Hard Stop Loss          (fires inside hold window)
 *   P2  Profit Lock / Trailing  (post-hold only — minimum 2 bars respected)
 *   P3  First-Move Protection   (arms lock — no forced exit)
 *   P4  Structure Failure       (post-hold only)
 *   P5b Score Below Floor       (post-hold, non-TRENDING only)
 *   P5c Bias Reversal           (post-hold; TRENDING requires score ≥ strongExitScore)
 *   P6a Time / No Improvement   (post-hold, non-TRENDING only)
 *   P6b Time / Stagnation       (post-hold, non-TRENDING only)
 *   P6c RANGING Time Limit      (post-hold, RANGING only)
 *   P7  No-Hope                 (post-hold, non-TRENDING only)
 *
 * Removed:
 *   P5a Score Collapsed — removed (score drop alone is not an exit signal)
 */
@Slf4j
public class ExitEvaluator {

    // ── Signal ────────────────────────────────────────────────────────────────

    public enum DesiredSideHint { NONE, CE, PE }

    public static class ExitSignal {
        public final String          reason;
        public final double          exitPx;
        public final DesiredSideHint desiredSide;
        /** true = signal fires even inside the hold window */
        public final boolean         allowedInHold;

        ExitSignal(String reason, double exitPx, DesiredSideHint side, boolean allowedInHold) {
            this.reason        = reason;
            this.exitPx        = exitPx;
            this.desiredSide   = side;
            this.allowedInHold = allowedInHold;
        }
    }

    // ── Per-position state ────────────────────────────────────────────────────

    @Getter private double  peakPnlPct        = 0.0;
    @Getter private double  profitLockFloor   = Double.NEGATIVE_INFINITY;
    @Getter private boolean everProfitable    = false;
    @Getter private int     barsWithoutNewHigh = 0;
    @Getter private int     barsNegative      = 0;

    private double entryScore       = 0.0;
    private double entryOptionPrice = 0.0;

    private final Deque<CandleDto>                    niftyWindow = new ArrayDeque<>();
    private final OptionsReplayRequest.ExitConfig     ec;

    public ExitEvaluator(OptionsReplayRequest.ExitConfig ec) {
        this.ec = ec != null ? ec : new OptionsReplayRequest.ExitConfig();
    }

    // ── Reset on new entry ────────────────────────────────────────────────────

    public void onEntry(double entryScore, double entryOptionPrice) {
        this.entryScore        = entryScore;
        this.entryOptionPrice  = entryOptionPrice;
        this.peakPnlPct        = 0.0;
        this.profitLockFloor   = Double.NEGATIVE_INFINITY;
        this.everProfitable    = false;
        this.barsWithoutNewHigh = 0;
        this.barsNegative      = 0;
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

        // ── Update rolling NIFTY window ───────────────────────────────────────
        if (niftyCandle != null) {
            niftyWindow.addLast(niftyCandle);
            while (niftyWindow.size() > ec.getStructureLookback()) {
                niftyWindow.removeFirst();
            }
        }

        // ── Track peak / consecutive counters ─────────────────────────────────
        if (currentPnlPct > peakPnlPct) {
            peakPnlPct         = currentPnlPct;
            barsWithoutNewHigh = 0;
        } else {
            barsWithoutNewHigh++;
        }

        if (currentPnlPct > 0) {
            everProfitable = true;
            barsNegative   = 0;
        } else {
            barsNegative++;
        }

        updateProfitLock(currentPnlPct);

        double exitPx = currentOptPx;

        // ════════════════════════════════════════════════════════════════════
        // P1 — Hard Stop Loss  (allowed inside hold window)
        // ════════════════════════════════════════════════════════════════════
        if (ec.getHardStopPct() > 0 && currentPnlPct <= -ec.getHardStopPct()) {
            double slPx = entryOptionPrice * (1 - ec.getHardStopPct() / 100.0);
            log.debug("EXIT P1 HARD_STOP pnl={}% <= -{}%",
                    String.format("%.2f", currentPnlPct), ec.getHardStopPct());
            return new ExitSignal("HARD_STOP_LOSS", Math.min(exitPx, slPx), DesiredSideHint.NONE, true);
        }

        // ════════════════════════════════════════════════════════════════════
        // P2 — Profit Lock / Trailing  (post-hold only — min 2 bars respected)
        // ════════════════════════════════════════════════════════════════════
        if (profitLockFloor > Double.NEGATIVE_INFINITY && currentPnlPct < profitLockFloor) {
            log.debug("EXIT P2 PROFIT_LOCK_HIT pnl={}% < floor={}%",
                    String.format("%.2f", currentPnlPct), String.format("%.2f", profitLockFloor));
            return new ExitSignal("PROFIT_LOCK_HIT", exitPx, DesiredSideHint.NONE, false);
        }

        // ════════════════════════════════════════════════════════════════════
        // P3 — First-Move Protection  (arms lock, no exit)
        // ════════════════════════════════════════════════════════════════════
        if (ec.getFirstMoveBars() > 0 && barsInTrade <= ec.getFirstMoveBars() && everProfitable) {
            double targetFloor = ec.getFirstMoveLockPct();
            if (profitLockFloor < targetFloor) {
                profitLockFloor = targetFloor;
                log.debug("EXIT P3 FIRST_MOVE_LOCK armed floor={}% at bar={}",
                        String.format("%.2f", targetFloor), barsInTrade);
            }
        }

        // ── P4-P7: blocked inside hold window (engine enforces) ──────────────

        // ════════════════════════════════════════════════════════════════════
        // P4 — Structure Failure (uses NIFTY close vs rolling high/low)
        // ════════════════════════════════════════════════════════════════════
        if (niftyWindow.size() >= Math.min(3, ec.getStructureLookback()) && niftyCandle != null
                && niftyCandle.close() != null) {
            double niftyClose = niftyCandle.close().doubleValue();

            if (positionType == OptionExecutionEngine.PositionState.LONG_CALL) {
                double support = niftyWindow.stream()
                        .filter(c -> c.low() != null)
                        .mapToDouble(c -> c.low().doubleValue())
                        .min().orElse(Double.MIN_VALUE);
                if (niftyClose < support) {
                    log.debug("EXIT P4 STRUCTURE_FAILURE_SUPPORT close={} < support={}",
                            String.format("%.2f", niftyClose), String.format("%.2f", support));
                    return new ExitSignal("STRUCTURE_FAILURE_SUPPORT", exitPx, DesiredSideHint.NONE, false);
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
                    return new ExitSignal("STRUCTURE_FAILURE_RESISTANCE", exitPx, DesiredSideHint.NONE, false);
                }
            }
        }

        // P5a — REMOVED: Score Collapsed exit removed.
        // Score drop alone is not a reliable exit signal.

        // ════════════════════════════════════════════════════════════════════
        // P5b — Score Below Absolute Floor + Neutral Bias
        //        Skipped in TRENDING — hold the trend regardless of score.
        // ════════════════════════════════════════════════════════════════════
        if (!isTrending
                && ec.getScoreAbsoluteMin() > 0
                && currentScore < ec.getScoreAbsoluteMin()
                && confirmedBias == NiftyDecisionResult.Bias.NEUTRAL) {
            log.debug("EXIT P5b SCORE_BELOW_FLOOR score={} < {} NEUTRAL",
                    String.format("%.1f", currentScore), ec.getScoreAbsoluteMin());
            return new ExitSignal("SCORE_BELOW_FLOOR", exitPx, DesiredSideHint.NONE, false);
        }

        // ════════════════════════════════════════════════════════════════════
        // P5c — Confirmed Bias Reversal
        //        TRENDING: require score >= strongExitScore (default 35).
        //        RANGING / other: fire on any confirmed bias flip.
        // ════════════════════════════════════════════════════════════════════
        if (ec.isBiasExitEnabled()) {
            boolean strongEnough = !isTrending || currentScore >= ec.getStrongExitScore();
            if (strongEnough) {
                if (positionType == OptionExecutionEngine.PositionState.LONG_CALL
                        && confirmedBias == NiftyDecisionResult.Bias.BEARISH) {
                    log.debug("EXIT P5c BIAS_REVERSAL LONG_CALL bearish confirmed score={}",
                            String.format("%.1f", currentScore));
                    return new ExitSignal("BIAS_REVERSAL", exitPx, DesiredSideHint.PE, false);
                }
                if (positionType == OptionExecutionEngine.PositionState.LONG_PUT
                        && confirmedBias == NiftyDecisionResult.Bias.BULLISH) {
                    log.debug("EXIT P5c BIAS_REVERSAL LONG_PUT bullish confirmed score={}",
                            String.format("%.1f", currentScore));
                    return new ExitSignal("BIAS_REVERSAL", exitPx, DesiredSideHint.CE, false);
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // P6a — Time: No Improvement (never profitable)
        //        Skipped in TRENDING — give trend trades room to develop.
        // ════════════════════════════════════════════════════════════════════
        if (!isTrending
                && ec.getMaxBarsNoImprovement() > 0
                && !everProfitable
                && barsInTrade >= ec.getMaxBarsNoImprovement()) {
            log.debug("EXIT P6a TIME_NO_IMPROVEMENT bars={}", barsInTrade);
            return new ExitSignal("TIME_NO_IMPROVEMENT", exitPx, DesiredSideHint.NONE, false);
        }

        // ════════════════════════════════════════════════════════════════════
        // P6b — Time: Stagnation (was profitable, peak not updated for N bars)
        //        Skipped in TRENDING.
        // ════════════════════════════════════════════════════════════════════
        if (!isTrending
                && ec.getStagnationBars() > 0
                && everProfitable
                && barsWithoutNewHigh >= ec.getStagnationBars()
                && currentPnlPct > 0) {
            log.debug("EXIT P6b TIME_STAGNATION noNewHighBars={} pnl={}%",
                    barsWithoutNewHigh, String.format("%.2f", currentPnlPct));
            return new ExitSignal("TIME_STAGNATION", exitPx, DesiredSideHint.NONE, false);
        }

        // ════════════════════════════════════════════════════════════════════
        // P6c — RANGING Time Limit
        //        In RANGING regime, cap trade duration to avoid range-bound
        //        trades that overstay and get caught on band reversals.
        // ════════════════════════════════════════════════════════════════════
        if (isRanging && ec.getMaxBarsRanging() > 0 && barsInTrade >= ec.getMaxBarsRanging()) {
            log.debug("EXIT P6c RANGING_TIME_LIMIT bars={} >= {}", barsInTrade, ec.getMaxBarsRanging());
            return new ExitSignal("RANGING_TIME_LIMIT", exitPx, DesiredSideHint.NONE, false);
        }

        // ════════════════════════════════════════════════════════════════════
        // P7 — No-Hope (sustained loss)
        //        Skipped in TRENDING — trailing stop (P2) handles loss control.
        // ════════════════════════════════════════════════════════════════════
        if (!isTrending
                && ec.getNoHopeThresholdPct() > 0
                && currentPnlPct <= -ec.getNoHopeThresholdPct()
                && barsNegative >= ec.getNoHopeBars()) {
            log.debug("EXIT P7 NO_HOPE pnl={}% barsNeg={}",
                    String.format("%.2f", currentPnlPct), barsNegative);
            return new ExitSignal("NO_HOPE", exitPx, DesiredSideHint.NONE, false);
        }

        return null; // HOLD
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
