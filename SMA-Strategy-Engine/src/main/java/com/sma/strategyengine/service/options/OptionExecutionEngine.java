package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.model.response.OptionsReplayCandleEvent;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * Option execution state machine.
 *
 * States: FLAT -> LONG_CALL -> LONG_PUT (and back)
 *
 * Exit priority (enforced by ExitEvaluator):
 *   P1  Hard Stop Loss          (fires inside hold window)
 *   P2  Profit Lock / Trailing  (fires inside hold window)
 *   P3  First-Move Protection   (arms lock only)
 *   P4  Structure Failure       (post-hold only)
 *   P5  Score / Bias Exit       (post-hold only)
 *   P6  Time Exit               (post-hold only)
 *   P7  No-Hope                 (post-hold only)
 */
@Slf4j
public class OptionExecutionEngine {

    public enum PositionState { FLAT, LONG_CALL, LONG_PUT }
    public enum DesiredSide   { NONE, CE, PE }

    @Getter private PositionState state       = PositionState.FLAT;
    @Getter private DesiredSide   desiredSide = DesiredSide.NONE;

    // Active position details
    @Getter private Long   activeToken;
    @Getter private double activeStrike;
    @Getter private String activeExpiry;
    @Getter private String activeTradingSymbol;
    @Getter private String activeOptionType;    // CE / PE
    @Getter private double entryPrice;
    @Getter private int    quantity;
    @Getter private int    barsInTrade;
    @Getter private String entryTimeStr;

    // Capital + P&L
    private double capital;
    @Getter private double realizedPnl   = 0;
    @Getter private double unrealizedPnl = 0;

    // Cooldown
    private int barsSinceLastTrade = 0;

    // Switch tracking
    @Getter private int    switchCountToday = 0;
    private String currentDate = null;

    // Config
    private final int maxSwitchesPerDay;
    private final int minBarsSinceTrade;
    private final int quantity0;
    private final BigDecimal initialCapital;

    // Hold management
    private final OptionsReplayRequest.HoldConfig hc;
    private int consecutiveWeakBars = 0;

    // Candle-bucket dedup — barsInTrade/consecutiveWeakBars only advance once per bucket
    private LocalDateTime lastBarTime = null;

    // Smart exit evaluator
    private final ExitEvaluator exitEval;

    // Per-candle observable fields
    @Getter private String  lastExitReason  = null;
    @Getter private String  execWaitReason  = null;   // why execution returned WAITING (separate from decision blockReason)
    @Getter private String  entryRegime     = null;
    @Getter private int     appliedMinHold  = 0;
    @Getter private boolean holdActive      = false;
    @Getter private double  peakPnlPct      = 0.0;
    @Getter private double  profitLockFloor = 0.0;
    @Getter private boolean inHoldZone      = false;
    @Getter private boolean inStrongTrendMode = false;

    // Risk management (legacy daily-loss-cap + cooldown — kept alongside ExitEvaluator)
    private final OptionsReplayRequest.RiskConfig rc;
    private double dailyRealizedPnl = 0;
    @Getter private int barsSinceLastLoss = Integer.MAX_VALUE;

    // Closed trades
    @Getter private final List<OptionsReplayCandleEvent.ClosedTrade> closedTrades = new ArrayList<>();

    public OptionExecutionEngine(OptionsReplayRequest req) {
        this.initialCapital    = req.getInitialCapital();
        this.capital           = initialCapital.doubleValue();
        this.maxSwitchesPerDay = req.getSwitchConfig().getMaxSwitchesPerDay();
        this.minBarsSinceTrade = req.getDecisionConfig().getMinBarsSinceTrade();
        this.quantity0         = req.getQuantity();
        this.rc  = req.getRiskConfig()  != null ? req.getRiskConfig()  : new OptionsReplayRequest.RiskConfig();
        this.hc  = req.getHoldConfig()  != null ? req.getHoldConfig()  : new OptionsReplayRequest.HoldConfig();
        this.exitEval = new ExitEvaluator(
                req.getExitConfig() != null ? req.getExitConfig() : new OptionsReplayRequest.ExitConfig());
        log.info("HoldConfig: enabled={} default={} ranging={} trending={} strongOpp={} persist={}",
                hc.isEnabled(), hc.getDefaultMinHoldBars(), hc.getRangingMinHoldBars(),
                hc.getTrendingMinHoldBars(), hc.getStrongOppositeScore(), hc.getPersistentExitBars());
        log.info("ExitConfig: enabled={} hardStop={}% lock1={}/{}% lock2={}/{}% trail={}/{}x firstMove={}/{} struct={} scoreDrop={} scoreMin={} noImprove={} stagnate={} noHope={}/{} breakeven={}/{}%",
                req.getExitConfig() != null ? req.getExitConfig().isEnabled() : true,
                req.getExitConfig() != null ? req.getExitConfig().getHardStopPct() : 7,
                req.getExitConfig() != null ? req.getExitConfig().getLock1TriggerPct() : 2,
                req.getExitConfig() != null ? req.getExitConfig().getLock1FloorPct() : 1,
                req.getExitConfig() != null ? req.getExitConfig().getLock2TriggerPct() : 4,
                req.getExitConfig() != null ? req.getExitConfig().getLock2FloorPct() : 2,
                req.getExitConfig() != null ? req.getExitConfig().getTrailTriggerPct() : 6,
                req.getExitConfig() != null ? req.getExitConfig().getTrailFactor() : 0.5,
                req.getExitConfig() != null ? req.getExitConfig().getFirstMoveBars() : 2,
                req.getExitConfig() != null ? req.getExitConfig().getFirstMoveLockPct() : 0.5,
                req.getExitConfig() != null ? req.getExitConfig().getStructureLookback() : 5,
                req.getExitConfig() != null ? req.getExitConfig().getScoreDropFactor() : 0.6,
                req.getExitConfig() != null ? req.getExitConfig().getScoreAbsoluteMin() : 20,
                req.getExitConfig() != null ? req.getExitConfig().getMaxBarsNoImprovement() : 3,
                req.getExitConfig() != null ? req.getExitConfig().getStagnationBars() : 2,
                req.getExitConfig() != null ? req.getExitConfig().getNoHopeThresholdPct() : 1.5,
                req.getExitConfig() != null ? req.getExitConfig().getNoHopeBars() : 2,
                req.getExitConfig() != null ? req.getExitConfig().isBreakevenProtectionEnabled() : true,
                req.getExitConfig() != null ? req.getExitConfig().getBreakevenTriggerPct() : 2.0);
    }

    public int    getBarsSinceLastTrade() { return barsSinceLastTrade; }
    public double getCapital()            { return capital; }

    // ── Main per-candle entry point ───────────────────────────────────────────

    public String process(NiftyDecisionResult decision,
                          OptionSelectorService selector,
                          List<OptionsReplayRequest.OptionCandidate> cePool,
                          List<OptionsReplayRequest.OptionCandidate> pePool,
                          double niftyClose,
                          LocalDateTime candleTime,
                          CandleDto niftyCandle) {

        // Reset daily counters
        String dateStr = candleTime != null ? candleTime.toLocalDate().toString() : null;
        if (dateStr != null && !dateStr.equals(currentDate)) {
            currentDate      = dateStr;
            switchCountToday = 0;
            dailyRealizedPnl = 0;
        }

        barsSinceLastTrade++;
        if (barsSinceLastLoss < Integer.MAX_VALUE) barsSinceLastLoss++;
        unrealizedPnl   = 0;
        lastExitReason  = null;
        execWaitReason  = null;
        holdActive      = false;

        // Advance bar-level counters only once per candle bucket — many ticks can share the same openTime
        boolean isNewBar = (candleTime != null && !candleTime.equals(lastBarTime));
        if (isNewBar) lastBarTime = candleTime;

        // Update unrealized P&L and bar count (unconditional — option candle absence does not freeze counter)
        if (state != PositionState.FLAT && activeToken != null) {
            if (isNewBar) barsInTrade++;   // candle-based, not tick-based
            CandleDto optCandle = selector.getCandle(activeToken, candleTime);
            if (optCandle != null && optCandle.close() != null) {
                unrealizedPnl = (optCandle.close().doubleValue() - entryPrice) * quantity;
            }
        }

        // Expose latest exit-eval state for the SSE event builder
        peakPnlPct        = exitEval.getPeakPnlPct();
        profitLockFloor   = exitEval.getProfitLockFloor() == Double.NEGATIVE_INFINITY
                ? 0.0 : exitEval.getProfitLockFloor();
        inHoldZone        = state != PositionState.FLAT && exitEval.isInHoldZone();
        inStrongTrendMode = state != PositionState.FLAT && exitEval.isInStrongTrendMode();

        return switch (state) {
            case FLAT      -> processFlatState(decision, selector, cePool, pePool, niftyClose, candleTime);
            case LONG_CALL -> processHeldState(decision, selector, candleTime, niftyCandle, PositionState.LONG_CALL, isNewBar);
            case LONG_PUT  -> processHeldState(decision, selector, candleTime, niftyCandle, PositionState.LONG_PUT, isNewBar);
        };
    }

    // ── FLAT: look for entry ──────────────────────────────────────────────────

    private String processFlatState(NiftyDecisionResult decision,
                                    OptionSelectorService selector,
                                    List<OptionsReplayRequest.OptionCandidate> cePool,
                                    List<OptionsReplayRequest.OptionCandidate> pePool,
                                    double niftyClose, LocalDateTime candleTime) {

        NiftyDecisionResult.Bias bias = decision.getConfirmedBias();

        boolean wantCE = (bias == NiftyDecisionResult.Bias.BULLISH)
                && (desiredSide == DesiredSide.NONE || desiredSide == DesiredSide.CE);
        boolean wantPE = (bias == NiftyDecisionResult.Bias.BEARISH)
                && (desiredSide == DesiredSide.NONE || desiredSide == DesiredSide.PE);

        if (!decision.isEntryAllowed())                                          return "WAITING";
        if (barsSinceLastTrade < minBarsSinceTrade) {
            execWaitReason = "minBars cooldown (" + barsSinceLastTrade + "/" + minBarsSinceTrade + ")";
            return "WAITING";
        }
        if (switchCountToday >= maxSwitchesPerDay && desiredSide != DesiredSide.NONE) {
            execWaitReason = "max switches reached (" + switchCountToday + "/" + maxSwitchesPerDay + ")";
            return "WAITING";
        }

        if (rc.isEnabled() && rc.getDailyLossCapPct() > 0
                && dailyRealizedPnl < -(initialCapital.doubleValue() * rc.getDailyLossCapPct() / 100)) {
            execWaitReason = "daily loss cap hit";
            return "WAITING";
        }
        if (rc.isEnabled() && rc.getCooldownCandles() > 0
                && barsSinceLastLoss < rc.getCooldownCandles()) {
            execWaitReason = "risk cooldown (" + barsSinceLastLoss + "/" + rc.getCooldownCandles() + ")";
            return "WAITING";
        }

        if (wantCE) {
            OptionsReplayRequest.OptionCandidate cand = selector.select(cePool, niftyClose, candleTime);
            if (cand == null) {
                execWaitReason = "CE: no valid candidate in pool";
                return "WAITING";
            }
            double prem = selector.getPremium(cand.getInstrumentToken(), candleTime);
            if (prem <= 0) {
                execWaitReason = "CE: no option price data at " + candleTime + " for " + cand.getTradingSymbol();
                log.warn("CE entry blocked — no price data for {} at {}", cand.getTradingSymbol(), candleTime);
                return "WAITING";
            }
            enterPosition(cand, prem, PositionState.LONG_CALL, candleTime,
                    decision.getRegime(), decision.getWinnerScore());
            desiredSide = DesiredSide.NONE;
            return "ENTERED";
        } else if (wantPE) {
            OptionsReplayRequest.OptionCandidate cand = selector.select(pePool, niftyClose, candleTime);
            if (cand == null) {
                execWaitReason = "PE: no valid candidate in pool";
                return "WAITING";
            }
            double prem = selector.getPremium(cand.getInstrumentToken(), candleTime);
            if (prem <= 0) {
                execWaitReason = "PE: no option price data at " + candleTime + " for " + cand.getTradingSymbol();
                log.warn("PE entry blocked — no price data for {} at {}", cand.getTradingSymbol(), candleTime);
                return "WAITING";
            }
            enterPosition(cand, prem, PositionState.LONG_PUT, candleTime,
                    decision.getRegime(), decision.getWinnerScore());
            desiredSide = DesiredSide.NONE;
            return "ENTERED";
        }

        return "WAITING";
    }

    // ── LONG_CALL / LONG_PUT: unified hold + exit logic ───────────────────────

    private String processHeldState(NiftyDecisionResult decision,
                                    OptionSelectorService selector,
                                    LocalDateTime candleTime,
                                    CandleDto niftyCandle,
                                    PositionState posType,
                                    boolean isNewBar) {

        NiftyDecisionResult.Bias confirmedBias = decision.getConfirmedBias();

        // Current option price for exit evaluator
        CandleDto optCandle = selector.getCandle(activeToken, candleTime);
        double currentOptPx = (optCandle != null && optCandle.close() != null)
                ? optCandle.close().doubleValue() : entryPrice;

        // ── Run exit evaluator ────────────────────────────────────────────────
        ExitEvaluator.ExitSignal signal = exitEval.evaluate(
                barsInTrade,
                currentOptPx,
                decision.getWinnerScore(),
                confirmedBias,
                posType,
                niftyCandle,
                decision.getRegime()
        );

        int minHold = resolveMinHold(decision.getRegime());
        this.appliedMinHold = minHold;
        boolean inHoldWindow = hc.isEnabled() && barsInTrade <= minHold;
        if (inHoldWindow) this.holdActive = true;

        // ── Apply exit signal ─────────────────────────────────────────────────
        if (signal != null) {
            // Inside hold window — only P1/P2 may fire
            if (inHoldWindow && !signal.allowedInHold) {
                log.debug("HOLD_BLOCKED exit={} bar={}/{} regime={}",
                        signal.reason, barsInTrade, minHold, decision.getRegime());
            } else {
                // Determine desired side after exit
                DesiredSide nextSide = DesiredSide.NONE;
                if (signal.desiredSide == ExitEvaluator.DesiredSideHint.PE) {
                    nextSide = DesiredSide.PE;
                    switchCountToday++;
                    decision.setSwitchCountToday(switchCountToday);
                } else if (signal.desiredSide == ExitEvaluator.DesiredSideHint.CE) {
                    nextSide = DesiredSide.CE;
                    switchCountToday++;
                    decision.setSwitchCountToday(switchCountToday);
                }
                closePosition(signal.exitPx, signal.reason, candleTime);
                desiredSide = nextSide;
                return "EXITED";
            }
        }

        // ── Hold window: only P1 (SL) may exit — all other signals blocked ───
        if (inHoldWindow) {
            consecutiveWeakBars = 0;
            log.debug("HOLD_ACTIVE bar={}/{} regime={} bias={}", barsInTrade, minHold, decision.getRegime(), confirmedBias);
            return "HELD";
        }

        // ── Post-hold: persistent exit counter (bias-based fallback) ─────────
        // Skipped in TRENDING — ExitEvaluator P2 (trailing stop) and P5c
        // (strong opposite bias) handle all exits in trend trades.
        // This path fires only for non-TRENDING regimes when ExitEvaluator
        // is disabled or its bias exit is off.
        boolean isTrending = "TRENDING".equals(decision.getRegime());
        if (isTrending) {
            consecutiveWeakBars = 0;
            return "HELD";
        }

        boolean favourable = (posType == PositionState.LONG_CALL && confirmedBias == NiftyDecisionResult.Bias.BULLISH)
                          || (posType == PositionState.LONG_PUT  && confirmedBias == NiftyDecisionResult.Bias.BEARISH);

        if (favourable) {
            consecutiveWeakBars = 0;
            return "HELD";
        }

        if (isNewBar) consecutiveWeakBars++;
        if (consecutiveWeakBars >= hc.getPersistentExitBars()) {
            log.debug("EXIT_PERSISTENT bias={} weakBars={}/{}", confirmedBias, consecutiveWeakBars, hc.getPersistentExitBars());
            String exitReason = (posType == PositionState.LONG_CALL && confirmedBias == NiftyDecisionResult.Bias.BEARISH)
                    || (posType == PositionState.LONG_PUT && confirmedBias == NiftyDecisionResult.Bias.BULLISH)
                    ? "BIAS_SWITCH" : "BIAS_INVALIDATED";
            closePosition(currentOptPx, exitReason, candleTime);
            if ("BIAS_SWITCH".equals(exitReason)) {
                desiredSide = posType == PositionState.LONG_CALL ? DesiredSide.PE : DesiredSide.CE;
                switchCountToday++;
                decision.setSwitchCountToday(switchCountToday);
            } else {
                desiredSide = DesiredSide.NONE;
            }
            return "EXITED";
        }

        log.debug("HOLD_POST_HOLD weakBars={}/{} bias={}", consecutiveWeakBars, hc.getPersistentExitBars(), confirmedBias);
        return "HELD";
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private int resolveMinHold(String regime) {
        if (!hc.isEnabled()) return 0;
        if ("RANGING".equals(regime))  return hc.getRangingMinHoldBars();
        if ("TRENDING".equals(regime)) return hc.getTrendingMinHoldBars();
        return hc.getDefaultMinHoldBars();
    }

    /** Force-close open position at end of replay. */
    public String forceClose(OptionSelectorService selector, LocalDateTime candleTime) {
        if (state == PositionState.FLAT) return "FLAT";
        CandleDto optCandle = selector.getCandle(activeToken, candleTime);
        double exitPrice = optCandle != null && optCandle.close() != null
                ? optCandle.close().doubleValue() : entryPrice;
        closePosition(exitPrice, "END_OF_REPLAY", candleTime);
        return "FORCE_CLOSED";
    }

    // ── Position lifecycle ────────────────────────────────────────────────────

    private void enterPosition(OptionsReplayRequest.OptionCandidate cand,
                               double premium, PositionState newState,
                               LocalDateTime time, String regime, double winnerScore) {
        this.state               = newState;
        this.activeToken         = cand.getInstrumentToken();
        this.activeStrike        = cand.getStrike();
        this.activeExpiry        = cand.getExpiry();
        this.activeTradingSymbol = cand.getTradingSymbol();
        this.activeOptionType    = cand.getOptionType();
        this.entryPrice          = premium;

        if (quantity0 > 0) {
            this.quantity = quantity0;
        } else if (rc.isEnabled() && rc.getMaxRiskPerTradePct() > 0 && rc.getStopLossPct() > 0) {
            double maxLoss    = capital * rc.getMaxRiskPerTradePct() / 100;
            double lossPerLot = premium * rc.getStopLossPct() / 100 * 100;
            this.quantity     = Math.max(1, (int)(maxLoss / lossPerLot)) * 100;
        } else {
            this.quantity = Math.max(1, (int)(capital / premium / 100) * 100);
        }

        this.barsInTrade         = 0;
        this.barsSinceLastTrade  = 0;
        this.consecutiveWeakBars = 0;
        this.lastBarTime         = null; // reset so first tick in same bucket starts bar 1
        this.entryRegime         = regime;
        this.appliedMinHold      = resolveMinHold(regime);
        this.entryTimeStr        = time != null ? time.toString() : null;

        exitEval.onEntry(winnerScore, premium);

        log.info("Entered {} @ {} — {} qty={} regime={} minHold={}",
                newState, premium, activeTradingSymbol, quantity, regime, appliedMinHold);
    }

    private void closePosition(double exitPx, String reason, LocalDateTime time) {
        lastExitReason = reason;
        double pnl = (exitPx - entryPrice) * quantity;
        realizedPnl      += pnl;
        dailyRealizedPnl += pnl;
        capital          += pnl;
        if (pnl < 0) barsSinceLastLoss = 0;

        closedTrades.add(OptionsReplayCandleEvent.ClosedTrade.builder()
                .entryTime(entryTimeStr)
                .exitTime(time != null ? time.toString() : null)
                .optionType(activeOptionType)
                .tradingSymbol(activeTradingSymbol)
                .strike(activeStrike)
                .expiry(activeExpiry)
                .entryPrice(entryPrice)
                .exitPrice(exitPx)
                .quantity(quantity)
                .pnl(pnl)
                .pnlPct(entryPrice > 0 ? (exitPx - entryPrice) / entryPrice * 100 : 0)
                .exitReason(reason)
                .barsInTrade(barsInTrade)
                .capitalAfter(capital)
                .entryRegime(entryRegime)
                .build());

        log.info("Closed {} — exit={} pnl={} reason={} bars={}",
                activeTradingSymbol, exitPx, String.format("%.2f", pnl), reason, barsInTrade);

        state                = PositionState.FLAT;
        activeToken          = null;
        activeStrike         = 0;
        activeExpiry         = null;
        activeTradingSymbol  = null;
        activeOptionType     = null;
        entryPrice           = 0;
        quantity             = 0;
        barsInTrade          = 0;
        barsSinceLastTrade   = 0;
        unrealizedPnl        = 0;
        entryRegime          = null;
        appliedMinHold       = 0;
        consecutiveWeakBars  = 0;
    }
}
