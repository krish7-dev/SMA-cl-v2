package com.sma.strategyengine.service;

import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.client.DataEngineClient.HistoryRequest;
import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.request.BacktestRequest.RiskConfig;
import com.sma.strategyengine.model.request.BacktestRequest.StrategyConfig;
import com.sma.strategyengine.model.response.BacktestResult;
import com.sma.strategyengine.model.response.BacktestResult.Metrics;
import com.sma.strategyengine.model.response.BacktestResult.StrategyRunResult;
import com.sma.strategyengine.model.response.BacktestResult.TradeEntry;
import com.sma.strategyengine.strategy.StrategyContext;
import com.sma.strategyengine.strategy.StrategyLogic;
import com.sma.strategyengine.strategy.StrategyRegistry;
import com.sma.strategyengine.strategy.StrategyResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.*;

/**
 * Backtesting engine.
 *
 * Algorithm (long-only, signal-on-close):
 *   For each candle fed to an active strategy:
 *     FLAT  + BUY  signal → enter LONG at candle close
 *     LONG  + SELL signal → exit at candle close, record trade, back to FLAT
 *   End of data: force-close any open LONG at last candle close.
 *
 * Each strategy config gets its own isolated ephemeral instanceId so price
 * windows in stateful strategies do not bleed into each other or into live state.
 * In-memory state is cleaned up via onInstanceRemoved after each run.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BacktestService {

    private final DataEngineClient dataEngineClient;
    private final StrategyRegistry strategyRegistry;

    // ─── Public API ───────────────────────────────────────────────────────────

    public BacktestResult run(BacktestRequest req) {
        // 1. Fetch candles from Data Engine
        List<CandleDto> candles = fetchCandles(req);
        if (candles.isEmpty()) {
            throw new IllegalStateException(
                    "No historical candle data returned for " + req.getSymbol() + "/" + req.getExchange() +
                    " [" + req.getInterval() + "] from " + req.getFromDate() + " to " + req.getToDate() +
                    ". Fetch historical data via Data Engine first.");
        }

        log.info("Backtest: {} candles for {}/{}, {} strategy configuration(s)",
                candles.size(), req.getSymbol(), req.getExchange(), req.getStrategies().size());

        // 2. Resolve quantity — 0 means "auto: max units from capital"
        int resolvedQty = req.getQuantity();
        if (resolvedQty <= 0) {
            BigDecimal firstClose = candles.get(0).close();
            if (firstClose != null && firstClose.compareTo(BigDecimal.ZERO) > 0) {
                resolvedQty = req.getInitialCapital().divide(firstClose, 0, RoundingMode.FLOOR).intValue();
            }
            resolvedQty = Math.max(1, resolvedQty);
            log.info("Backtest: auto quantity = {} (capital={} / firstClose={})",
                    resolvedQty, req.getInitialCapital(), candles.get(0).close());
        }

        // 3. Run each strategy config
        final int qty = resolvedQty;
        List<StrategyRunResult> results = new ArrayList<>();
        for (StrategyConfig cfg : req.getStrategies()) {
            results.add(runOneStrategy(req, cfg, candles, qty));
        }

        // 3. Find best by totalPnl
        String bestLabel = results.stream()
                .max(Comparator.comparing(r -> r.getMetrics().getTotalPnl()))
                .map(StrategyRunResult::getLabel)
                .orElse(null);

        return BacktestResult.builder()
                .symbol(req.getSymbol().toUpperCase())
                .exchange(req.getExchange().toUpperCase())
                .interval(req.getInterval())
                .fromDate(req.getFromDate())
                .toDate(req.getToDate())
                .totalCandles(candles.size())
                .resolvedQuantity(qty)
                .bestStrategyLabel(bestLabel)
                .results(results)
                .build();
    }

    // ─── Per-strategy simulation ───────────────────────────────────────────────

    private StrategyRunResult runOneStrategy(BacktestRequest req, StrategyConfig cfg, List<CandleDto> candles, int resolvedQty) {
        String instanceId = "BT-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase();
        String label = resolveLabel(cfg);
        Map<String, String> params = cfg.getParameters() != null ? cfg.getParameters() : Map.of();

        StrategyLogic logic = strategyRegistry.resolve(cfg.getStrategyType());

        // ── Risk config ──────────────────────────────────────────────────────
        RiskConfig rc    = req.getRiskConfig();
        boolean    riskOn = rc != null && rc.isEnabled();

        // Pre-compute fractional multipliers (e.g. stopLossPct=2 → slFrac=0.02)
        BigDecimal slFrac   = fracOrNull(rc == null ? null : rc.getStopLossPct());
        BigDecimal tpFrac   = fracOrNull(rc == null ? null : rc.getTakeProfitPct());
        BigDecimal riskFrac = (riskOn && slFrac != null) ? fracOrNull(rc.getMaxRiskPerTradePct()) : null;
        BigDecimal capFrac  = fracOrNull(rc == null ? null : rc.getDailyLossCapPct());

        // ── Capital / drawdown tracking ──────────────────────────────────────
        List<TradeEntry> trades        = new ArrayList<>();
        BigDecimal       runningCapital = req.getInitialCapital();
        BigDecimal       peak           = runningCapital;
        double           maxDrawdown    = 0.0;

        // ── Position state ───────────────────────────────────────────────────
        boolean    inPosition  = false;
        BigDecimal entryPrice  = null;
        CandleDto  entryCandle = null;
        BigDecimal slPrice     = null;   // null when risk off or SL disabled
        BigDecimal tpPrice     = null;
        int        tradeQty    = resolvedQty;

        // ── Risk state ───────────────────────────────────────────────────────
        int        cooldownRemaining = 0;
        LocalDate  currentDay        = null;
        BigDecimal dailyLossStart    = runningCapital;
        int        slExits = 0, tpExits = 0, dailyCapHalts = 0;

        try {
            for (CandleDto candle : candles) {

                // ── 1. Day boundary reset ────────────────────────────────────
                if (riskOn && candle.openTime() != null) {
                    LocalDate candleDay = candle.openTime().toLocalDate();
                    if (!candleDay.equals(currentDay)) {
                        currentDay     = candleDay;
                        dailyLossStart = runningCapital;
                    }
                }

                // ── 2. Always evaluate strategy (maintains indicator warmup) ─
                StrategyContext ctx = StrategyContext.builder()
                        .instanceId(instanceId)
                        .strategyType(cfg.getStrategyType())
                        .userId(req.getUserId())
                        .brokerName(req.getBrokerName())
                        .symbol(req.getSymbol().toUpperCase())
                        .exchange(req.getExchange().toUpperCase())
                        .product(req.getProduct())
                        .quantity(tradeQty)
                        .orderType("MARKET")
                        .candleOpenTime(candle.openTime() != null ? candle.openTime().toInstant(ZoneOffset.UTC) : null)
                        .candleOpen(candle.open())
                        .candleHigh(candle.high())
                        .candleLow(candle.low())
                        .candleClose(candle.close())
                        .candleVolume(candle.volume() != null ? candle.volume() : 0L)
                        .params(params)
                        .build();

                StrategyResult result = logic.evaluate(ctx);

                // ── 3. In-position checks ────────────────────────────────────
                if (inPosition) {
                    BigDecimal exitPrice = null;
                    String     exitReason = null;

                    if (riskOn) {
                        // SL: candle low ≤ slPrice
                        if (slPrice != null && candle.low() != null
                                && candle.low().compareTo(slPrice) <= 0) {
                            exitPrice  = slPrice;
                            exitReason = "STOP_LOSS";
                            slExits++;
                        }
                        // TP: candle high ≥ tpPrice (only if SL not triggered)
                        else if (tpPrice != null && candle.high() != null
                                && candle.high().compareTo(tpPrice) >= 0) {
                            exitPrice  = tpPrice;
                            exitReason = "TAKE_PROFIT";
                            tpExits++;
                        }
                    }

                    // Strategy SELL signal (only if not already exited via SL/TP)
                    if (exitPrice == null && result.isSell()) {
                        exitPrice  = candle.close();
                        exitReason = "SIGNAL";
                    }

                    if (exitPrice != null) {
                        TradeEntry trade = buildTrade(entryCandle, candle, entryPrice, exitPrice,
                                                      tradeQty, runningCapital, exitReason);
                        trades.add(trade);
                        runningCapital = trade.getRunningCapital();

                        // Drawdown
                        peak = peak.max(runningCapital);
                        if (peak.compareTo(BigDecimal.ZERO) > 0) {
                            double dd = peak.subtract(runningCapital)
                                    .divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                            maxDrawdown = Math.max(maxDrawdown, dd);
                        }

                        // Cooldown on loss
                        if (riskOn && rc.getCooldownCandles() > 0
                                && trade.getPnl().compareTo(BigDecimal.ZERO) <= 0) {
                            cooldownRemaining = rc.getCooldownCandles();
                        }

                        inPosition  = false;
                        entryPrice  = null;
                        entryCandle = null;
                        slPrice     = null;
                        tpPrice     = null;
                    }

                // ── 4. Flat — entry check ────────────────────────────────────
                } else {
                    if (riskOn) {
                        if (cooldownRemaining > 0) {
                            cooldownRemaining--;
                            continue;  // skip entry this candle
                        }
                        // Daily loss cap check
                        boolean dailyCapHit = false;
                        if (capFrac != null && dailyLossStart.compareTo(BigDecimal.ZERO) > 0) {
                            BigDecimal lost = dailyLossStart.subtract(runningCapital)
                                    .divide(dailyLossStart, 8, RoundingMode.HALF_UP);
                            if (lost.compareTo(capFrac) >= 0) {
                                dailyCapHit = true;
                                dailyCapHalts++;
                            }
                        }
                        if (!dailyCapHit && result.isBuy() && candle.close() != null
                                && candle.close().compareTo(BigDecimal.ZERO) > 0) {
                            // Position sizing via risk-per-trade
                            tradeQty = resolvedQty;
                            if (riskFrac != null && slFrac != null) {
                                BigDecimal riskAmount  = runningCapital.multiply(riskFrac);
                                BigDecimal riskPerUnit = candle.close().multiply(slFrac);
                                if (riskPerUnit.compareTo(BigDecimal.ZERO) > 0) {
                                    int sized = riskAmount.divide(riskPerUnit, 0, RoundingMode.FLOOR).intValue();
                                    tradeQty = Math.max(1, Math.min(sized, resolvedQty));
                                }
                            }
                            inPosition  = true;
                            entryPrice  = candle.close();
                            entryCandle = candle;
                            slPrice = slFrac != null
                                    ? entryPrice.multiply(BigDecimal.ONE.subtract(slFrac)).setScale(2, RoundingMode.HALF_UP)
                                    : null;
                            tpPrice = tpFrac != null
                                    ? entryPrice.multiply(BigDecimal.ONE.add(tpFrac)).setScale(2, RoundingMode.HALF_UP)
                                    : null;
                        }
                    } else {
                        // Risk OFF — original signal-only logic
                        if (result.isBuy()) {
                            inPosition  = true;
                            entryPrice  = candle.close();
                            entryCandle = candle;
                            tradeQty    = resolvedQty;
                        }
                    }
                }
            }

            // Force-close any open position at last candle
            if (inPosition && !candles.isEmpty()) {
                CandleDto last = candles.get(candles.size() - 1);
                TradeEntry trade = buildTrade(entryCandle, last, entryPrice, last.close(),
                                             tradeQty, runningCapital, "END_OF_BACKTEST");
                trades.add(trade);
                runningCapital = trade.getRunningCapital();
                peak = peak.max(runningCapital);
                if (peak.compareTo(BigDecimal.ZERO) > 0) {
                    double dd = peak.subtract(runningCapital)
                            .divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                    maxDrawdown = Math.max(maxDrawdown, dd);
                }
            }

        } finally {
            logic.onInstanceRemoved(instanceId);
        }

        Metrics metrics = computeMetrics(trades, req.getInitialCapital(), runningCapital,
                maxDrawdown, params, cfg.getStrategyType(), slExits, tpExits, dailyCapHalts);

        log.info("Backtest [{}]: {} trades, winRate={}%, totalPnl={}, return={}%{}",
                label, metrics.getTotalTrades(), metrics.getWinRate(),
                metrics.getTotalPnl(), metrics.getTotalReturnPct(),
                riskOn ? " [risk: SL=" + slExits + " TP=" + tpExits + " capHalts=" + dailyCapHalts + "]" : "");

        return StrategyRunResult.builder()
                .strategyType(cfg.getStrategyType())
                .label(label)
                .parameters(params)
                .metrics(metrics)
                .trades(trades)
                .build();
    }

    /** Converts a percentage BigDecimal (e.g. 2.0) to a fraction (0.02). Returns null if 0 or null. */
    private static BigDecimal fracOrNull(BigDecimal pct) {
        if (pct == null || pct.compareTo(BigDecimal.ZERO) <= 0) return null;
        return pct.divide(BigDecimal.valueOf(100), 8, RoundingMode.HALF_UP);
    }

    // ─── Trade builder ─────────────────────────────────────────────────────────

    private TradeEntry buildTrade(CandleDto entry, CandleDto exit,
                                  BigDecimal entryPrice, BigDecimal exitPrice,
                                  int qty, BigDecimal capitalBefore, String exitReason) {
        BigDecimal pnl = exitPrice.subtract(entryPrice)
                .multiply(BigDecimal.valueOf(qty))
                .setScale(2, RoundingMode.HALF_UP);
        double pnlPct = entryPrice.compareTo(BigDecimal.ZERO) == 0 ? 0.0
                : pnl.divide(entryPrice.multiply(BigDecimal.valueOf(qty)), 6, RoundingMode.HALF_UP)
                      .doubleValue() * 100.0;
        BigDecimal runningCapital = capitalBefore.add(pnl).setScale(2, RoundingMode.HALF_UP);

        return TradeEntry.builder()
                .entryTime(entry != null ? entry.openTime() : null)
                .exitTime(exit.openTime())
                .entryPrice(entryPrice.setScale(2, RoundingMode.HALF_UP))
                .exitPrice(exitPrice.setScale(2, RoundingMode.HALF_UP))
                .quantity(qty)
                .pnl(pnl)
                .pnlPct(Math.round(pnlPct * 100.0) / 100.0)
                .runningCapital(runningCapital)
                .exitReason(exitReason)
                .build();
    }

    // ─── Metrics computation ───────────────────────────────────────────────────

    private Metrics computeMetrics(List<TradeEntry> trades, BigDecimal initialCapital,
                                   BigDecimal finalCapital, double maxDrawdown,
                                   Map<String, String> params, String strategyType,
                                   int slExits, int tpExits, int dailyCapHalts) {
        if (trades.isEmpty()) {
            return Metrics.builder()
                    .totalTrades(0).winningTrades(0).losingTrades(0)
                    .winRate(0).totalPnl(BigDecimal.ZERO)
                    .initialCapital(initialCapital).finalCapital(initialCapital)
                    .totalReturnPct(0).maxDrawdownPct(0).profitFactor(0)
                    .avgWin(BigDecimal.ZERO).avgLoss(BigDecimal.ZERO)
                    .bestTrade(BigDecimal.ZERO).worstTrade(BigDecimal.ZERO)
                    .sharpeRatio(0).warmupCandles(inferWarmup(params, strategyType))
                    .stopLossExits(slExits).takeProfitExits(tpExits).dailyCapHalts(dailyCapHalts)
                    .build();
        }

        long wins   = trades.stream().filter(t -> t.getPnl().compareTo(BigDecimal.ZERO) > 0).count();
        long losses = trades.stream().filter(t -> t.getPnl().compareTo(BigDecimal.ZERO) <= 0).count();

        BigDecimal grossProfit = trades.stream()
                .filter(t -> t.getPnl().compareTo(BigDecimal.ZERO) > 0)
                .map(TradeEntry::getPnl)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal grossLoss = trades.stream()
                .filter(t -> t.getPnl().compareTo(BigDecimal.ZERO) <= 0)
                .map(TradeEntry::getPnl)
                .reduce(BigDecimal.ZERO, BigDecimal::add).abs();

        BigDecimal totalPnl = finalCapital.subtract(initialCapital);
        double totalReturnPct = initialCapital.compareTo(BigDecimal.ZERO) == 0 ? 0.0
                : totalPnl.divide(initialCapital, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;

        double profitFactor = grossLoss.compareTo(BigDecimal.ZERO) == 0 ? 0.0
                : grossProfit.divide(grossLoss, 4, RoundingMode.HALF_UP).doubleValue();

        BigDecimal avgWin = wins == 0 ? BigDecimal.ZERO
                : grossProfit.divide(BigDecimal.valueOf(wins), 2, RoundingMode.HALF_UP);
        BigDecimal avgLoss = losses == 0 ? BigDecimal.ZERO
                : grossLoss.divide(BigDecimal.valueOf(losses), 2, RoundingMode.HALF_UP);

        BigDecimal best  = trades.stream().map(TradeEntry::getPnl).max(Comparator.naturalOrder()).orElse(BigDecimal.ZERO);
        BigDecimal worst = trades.stream().map(TradeEntry::getPnl).min(Comparator.naturalOrder()).orElse(BigDecimal.ZERO);

        double sharpe = computeSharpe(trades);

        return Metrics.builder()
                .totalTrades(trades.size())
                .winningTrades((int) wins)
                .losingTrades((int) losses)
                .winRate(trades.isEmpty() ? 0.0 : Math.round((double) wins / trades.size() * 10000.0) / 100.0)
                .totalPnl(totalPnl.setScale(2, RoundingMode.HALF_UP))
                .initialCapital(initialCapital)
                .finalCapital(finalCapital)
                .totalReturnPct(Math.round(totalReturnPct * 100.0) / 100.0)
                .maxDrawdownPct(Math.round(maxDrawdown * 100.0) / 100.0)
                .profitFactor(Math.round(profitFactor * 100.0) / 100.0)
                .avgWin(avgWin)
                .avgLoss(avgLoss)
                .bestTrade(best)
                .worstTrade(worst)
                .sharpeRatio(Math.round(sharpe * 100.0) / 100.0)
                .warmupCandles(inferWarmup(params, strategyType))
                .stopLossExits(slExits)
                .takeProfitExits(tpExits)
                .dailyCapHalts(dailyCapHalts)
                .build();
    }

    /**
     * Simplified trade-level Sharpe: mean(pnlPct) / stdDev(pnlPct).
     * Returns 0 if fewer than 2 trades or zero variance.
     */
    private double computeSharpe(List<TradeEntry> trades) {
        if (trades.size() < 2) return 0.0;
        double[] rets = trades.stream().mapToDouble(TradeEntry::getPnlPct).toArray();
        double mean = Arrays.stream(rets).average().orElse(0.0);
        double variance = Arrays.stream(rets).map(r -> (r - mean) * (r - mean)).average().orElse(0.0);
        double std = Math.sqrt(variance);
        return std == 0.0 ? 0.0 : mean / std;
    }

    /** Best-effort warmup inference from known strategy types and their params. */
    private int inferWarmup(Map<String, String> params, String strategyType) {
        if ("SMA_CROSSOVER".equals(strategyType)) {
            int longPeriod = 20;
            if (params != null && params.containsKey("longPeriod")) {
                try { longPeriod = Integer.parseInt(params.get("longPeriod")); } catch (Exception ignored) {}
            }
            return longPeriod + 1;
        }
        return 0;
    }

    // ─── Data fetch ───────────────────────────────────────────────────────────

    private List<CandleDto> fetchCandles(BacktestRequest req) {
        // Cap toDate to now — Kite rejects requests for candles that haven't closed yet
        LocalDateTime effectiveTo = req.getToDate().isAfter(LocalDateTime.now())
                ? LocalDateTime.now()
                : req.getToDate();

        HistoryRequest histReq = new HistoryRequest(
                req.getUserId(),
                req.getBrokerName(),
                req.getInstrumentToken(),
                req.getSymbol().toUpperCase(),
                req.getExchange().toUpperCase(),
                req.getInterval(),
                req.getFromDate(),
                effectiveTo,
                false  // backtest: skip DB persistence — fetch from Kite and return directly
        );
        log.info("Fetching historical candles: token={}, interval={}, from={}, to={}",
                req.getInstrumentToken(), req.getInterval(), req.getFromDate(), effectiveTo);
        return dataEngineClient.fetchHistory(histReq);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private String resolveLabel(StrategyConfig cfg) {
        if (cfg.getLabel() != null && !cfg.getLabel().isBlank()) return cfg.getLabel();
        Map<String, String> p = cfg.getParameters();
        if (p == null || p.isEmpty()) return cfg.getStrategyType();
        String paramStr = p.entrySet().stream()
                .map(e -> e.getKey() + "=" + e.getValue())
                .reduce((a, b) -> a + ", " + b).orElse("");
        return cfg.getStrategyType() + " (" + paramStr + ")";
    }
}
