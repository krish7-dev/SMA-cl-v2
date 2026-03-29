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
 * Rules:
 *  - Never short options
 *  - Only one position at a time
 *  - 2-step switching: exit first, set desired side, wait for fresh confirmation
 *  - Force-close at end of replay (exitReason = END_OF_REPLAY)
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
    @Getter private double realizedPnl  = 0;
    @Getter private double unrealizedPnl = 0;

    // Cooldown
    private int barsSinceLastTrade = 0;

    // Switch tracking
    @Getter private int    switchCountToday = 0;
    private String currentDate = null;

    // Daily switch limit (from config)
    private final int maxSwitchesPerDay;
    private final int minBarsSinceTrade;
    private final int quantity0;
    private final BigDecimal initialCapital;

    // Risk management
    private final OptionsReplayRequest.RiskConfig rc;
    private double dailyRealizedPnl = 0;
    private String dailyPnlDate     = null;
    private int    barsSinceLastLoss = Integer.MAX_VALUE;

    // Closed trades
    @Getter private final List<OptionsReplayCandleEvent.ClosedTrade> closedTrades = new ArrayList<>();

    public OptionExecutionEngine(OptionsReplayRequest req) {
        this.initialCapital  = req.getInitialCapital();
        this.capital         = initialCapital.doubleValue();
        this.maxSwitchesPerDay = req.getSwitchConfig().getMaxSwitchesPerDay();
        this.minBarsSinceTrade = req.getDecisionConfig().getMinBarsSinceTrade();
        this.quantity0         = req.getQuantity();
        this.rc = req.getRiskConfig() != null ? req.getRiskConfig() : new OptionsReplayRequest.RiskConfig();
    }

    public int getBarsSinceLastTrade() { return barsSinceLastTrade; }
    public double getCapital()          { return capital; }

    /**
     * Process one candle through the state machine.
     *
     * @param decision     NiftyDecisionResult for this candle
     * @param selector     OptionSelectorService (for instrument selection)
     * @param cePool       CE candidate pool
     * @param pePool       PE candidate pool
     * @param niftyClose   NIFTY close price for ATM calculation
     * @param candleTime   current candle time
     * @return action string (ENTERED / EXITED / HELD / WAITING / FORCE_CLOSED)
     */
    public String process(NiftyDecisionResult decision,
                          OptionSelectorService selector,
                          List<OptionsReplayRequest.OptionCandidate> cePool,
                          List<OptionsReplayRequest.OptionCandidate> pePool,
                          double niftyClose,
                          LocalDateTime candleTime) {

        // Reset daily counters
        String dateStr = candleTime != null ? candleTime.toLocalDate().toString() : null;
        if (dateStr != null && !dateStr.equals(currentDate)) {
            currentDate      = dateStr;
            switchCountToday = 0;
            dailyRealizedPnl = 0;
            dailyPnlDate     = dateStr;
        }

        barsSinceLastTrade++;
        if (barsSinceLastLoss < Integer.MAX_VALUE) barsSinceLastLoss++;
        unrealizedPnl = 0;

        // Update unrealized P&L if position is open
        if (state != PositionState.FLAT && activeToken != null) {
            CandleDto optCandle = selector.getCandle(activeToken, candleTime);
            if (optCandle != null && optCandle.close() != null) {
                double currentPrice = optCandle.close().doubleValue();
                unrealizedPnl = (currentPrice - entryPrice) * quantity;
                barsInTrade++;
            }
        }

        // ── State machine ─────────────────────────────────────────────────────
        return switch (state) {
            case FLAT    -> processFlatState(decision, selector, cePool, pePool, niftyClose, candleTime);
            case LONG_CALL -> processLongCallState(decision, selector, pePool, niftyClose, candleTime);
            case LONG_PUT  -> processLongPutState(decision, selector, cePool, niftyClose, candleTime);
        };
    }

    private String processFlatState(NiftyDecisionResult decision,
                                    OptionSelectorService selector,
                                    List<OptionsReplayRequest.OptionCandidate> cePool,
                                    List<OptionsReplayRequest.OptionCandidate> pePool,
                                    double niftyClose, LocalDateTime candleTime) {

        NiftyDecisionResult.Bias bias = decision.getConfirmedBias();

        // Determine which side we want
        boolean wantCE = (bias == NiftyDecisionResult.Bias.BULLISH)
                && (desiredSide == DesiredSide.NONE || desiredSide == DesiredSide.CE);
        boolean wantPE = (bias == NiftyDecisionResult.Bias.BEARISH)
                && (desiredSide == DesiredSide.NONE || desiredSide == DesiredSide.PE);

        if (!decision.isEntryAllowed()) return "WAITING";
        if (barsSinceLastTrade < minBarsSinceTrade) return "WAITING";
        if (switchCountToday >= maxSwitchesPerDay && desiredSide != DesiredSide.NONE) return "WAITING";

        // Risk: daily loss cap
        if (rc.isEnabled() && rc.getDailyLossCapPct() > 0
                && dailyRealizedPnl < -(initialCapital.doubleValue() * rc.getDailyLossCapPct() / 100)) {
            return "WAITING";
        }
        // Risk: cooldown after loss
        if (rc.isEnabled() && rc.getCooldownCandles() > 0
                && barsSinceLastLoss < rc.getCooldownCandles()) {
            return "WAITING";
        }

        if (wantCE) {
            OptionsReplayRequest.OptionCandidate cand = selector.select(cePool, niftyClose, candleTime);
            if (cand != null) {
                double prem = selector.getPremium(cand.getInstrumentToken(), candleTime);
                if (prem > 0) {
                    enterPosition(cand, prem, PositionState.LONG_CALL, candleTime);
                    desiredSide = DesiredSide.NONE;
                    return "ENTERED";
                }
            }
        } else if (wantPE) {
            OptionsReplayRequest.OptionCandidate cand = selector.select(pePool, niftyClose, candleTime);
            if (cand != null) {
                double prem = selector.getPremium(cand.getInstrumentToken(), candleTime);
                if (prem > 0) {
                    enterPosition(cand, prem, PositionState.LONG_PUT, candleTime);
                    desiredSide = DesiredSide.NONE;
                    return "ENTERED";
                }
            }
        }

        return "WAITING";
    }

    private String processLongCallState(NiftyDecisionResult decision,
                                        OptionSelectorService selector,
                                        List<OptionsReplayRequest.OptionCandidate> pePool,
                                        double niftyClose, LocalDateTime candleTime) {

        NiftyDecisionResult.Bias confirmedBias = decision.getConfirmedBias();

        // Risk: check SL/TP on option candle
        if (rc.isEnabled()) {
            CandleDto optCandle = selector.getCandle(activeToken, candleTime);
            if (optCandle != null) {
                if (rc.getStopLossPct() > 0 && optCandle.low() != null
                        && optCandle.low().doubleValue() <= entryPrice * (1 - rc.getStopLossPct() / 100)) {
                    double exitPrice = entryPrice * (1 - rc.getStopLossPct() / 100);
                    closePosition(exitPrice, "STOP_LOSS", candleTime);
                    desiredSide = DesiredSide.NONE;
                    return "EXITED";
                }
                if (rc.getTakeProfitPct() > 0 && optCandle.high() != null
                        && optCandle.high().doubleValue() >= entryPrice * (1 + rc.getTakeProfitPct() / 100)) {
                    double exitPrice = entryPrice * (1 + rc.getTakeProfitPct() / 100);
                    closePosition(exitPrice, "TAKE_PROFIT", candleTime);
                    desiredSide = DesiredSide.NONE;
                    return "EXITED";
                }
            }
        }

        if (confirmedBias != NiftyDecisionResult.Bias.BULLISH) {
            // Exit current CE position
            CandleDto optCandle = selector.getCandle(activeToken, candleTime);
            double exitPrice = optCandle != null && optCandle.close() != null
                    ? optCandle.close().doubleValue() : entryPrice;

            String exitReason = confirmedBias == NiftyDecisionResult.Bias.BEARISH
                    ? "BIAS_SWITCH" : "BIAS_INVALIDATED";

            closePosition(exitPrice, exitReason, candleTime);

            // 2-step switch: if bearish confirmed, set desired side to PE
            if (confirmedBias == NiftyDecisionResult.Bias.BEARISH) {
                desiredSide = DesiredSide.PE;
                switchCountToday++;
                decision.setSwitchCountToday(switchCountToday); // update decision result
            } else {
                desiredSide = DesiredSide.NONE;
            }
            return "EXITED";
        }

        return "HELD";
    }

    private String processLongPutState(NiftyDecisionResult decision,
                                       OptionSelectorService selector,
                                       List<OptionsReplayRequest.OptionCandidate> cePool,
                                       double niftyClose, LocalDateTime candleTime) {

        NiftyDecisionResult.Bias confirmedBias = decision.getConfirmedBias();

        // Risk: check SL/TP on option candle
        if (rc.isEnabled()) {
            CandleDto optCandle = selector.getCandle(activeToken, candleTime);
            if (optCandle != null) {
                if (rc.getStopLossPct() > 0 && optCandle.low() != null
                        && optCandle.low().doubleValue() <= entryPrice * (1 - rc.getStopLossPct() / 100)) {
                    double exitPrice = entryPrice * (1 - rc.getStopLossPct() / 100);
                    closePosition(exitPrice, "STOP_LOSS", candleTime);
                    desiredSide = DesiredSide.NONE;
                    return "EXITED";
                }
                if (rc.getTakeProfitPct() > 0 && optCandle.high() != null
                        && optCandle.high().doubleValue() >= entryPrice * (1 + rc.getTakeProfitPct() / 100)) {
                    double exitPrice = entryPrice * (1 + rc.getTakeProfitPct() / 100);
                    closePosition(exitPrice, "TAKE_PROFIT", candleTime);
                    desiredSide = DesiredSide.NONE;
                    return "EXITED";
                }
            }
        }

        if (confirmedBias != NiftyDecisionResult.Bias.BEARISH) {
            // Exit current PE position
            CandleDto optCandle = selector.getCandle(activeToken, candleTime);
            double exitPrice = optCandle != null && optCandle.close() != null
                    ? optCandle.close().doubleValue() : entryPrice;

            String exitReason = confirmedBias == NiftyDecisionResult.Bias.BULLISH
                    ? "BIAS_SWITCH" : "BIAS_INVALIDATED";

            closePosition(exitPrice, exitReason, candleTime);

            // 2-step switch: if bullish confirmed, set desired side to CE
            if (confirmedBias == NiftyDecisionResult.Bias.BULLISH) {
                desiredSide = DesiredSide.CE;
                switchCountToday++;
                decision.setSwitchCountToday(switchCountToday);
            } else {
                desiredSide = DesiredSide.NONE;
            }
            return "EXITED";
        }

        return "HELD";
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

    // ── Position helpers ──────────────────────────────────────────────────────

    private void enterPosition(OptionsReplayRequest.OptionCandidate cand,
                               double premium, PositionState newState,
                               LocalDateTime time) {
        this.state              = newState;
        this.activeToken        = cand.getInstrumentToken();
        this.activeStrike       = cand.getStrike();
        this.activeExpiry       = cand.getExpiry();
        this.activeTradingSymbol = cand.getTradingSymbol();
        this.activeOptionType   = cand.getOptionType();
        this.entryPrice         = premium;
        if (quantity0 > 0) {
            this.quantity = quantity0;
        } else if (rc.isEnabled() && rc.getMaxRiskPerTradePct() > 0 && rc.getStopLossPct() > 0) {
            double maxLoss = capital * rc.getMaxRiskPerTradePct() / 100;
            double lossPerLot = premium * rc.getStopLossPct() / 100 * 100; // per 100-unit lot
            int lots = Math.max(1, (int)(maxLoss / lossPerLot));
            this.quantity = lots * 100;
        } else {
            this.quantity = Math.max(1, (int)(capital / premium / 100) * 100);
        }
        this.barsInTrade        = 0;
        this.barsSinceLastTrade = 0;
        this.entryTimeStr       = time != null ? time.toString() : null;
        log.info("Entered {} @ {} — {} qty={}", newState, premium, activeTradingSymbol, quantity);
    }

    private void closePosition(double exitPx, String reason, LocalDateTime time) {
        double pnl = (exitPx - entryPrice) * quantity;
        realizedPnl      += pnl;
        dailyRealizedPnl += pnl;
        capital          += pnl;
        if (pnl < 0) {
            barsSinceLastLoss = 0;
        }

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
                .build());

        log.info("Closed {} — exit={} pnl={} reason={}", activeTradingSymbol, exitPx, pnl, reason);

        // Reset position state
        state              = PositionState.FLAT;
        activeToken        = null;
        activeStrike       = 0;
        activeExpiry       = null;
        activeTradingSymbol = null;
        activeOptionType   = null;
        entryPrice         = 0;
        quantity           = 0;
        barsInTrade        = 0;
        barsSinceLastTrade = 0;
        unrealizedPnl      = 0;
    }
}
