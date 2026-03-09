package com.sma.strategyengine.service;

import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.client.DataEngineClient.HistoryRequest;
import com.sma.strategyengine.model.request.BacktestRequest;
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

        // 2. Run each strategy config
        List<StrategyRunResult> results = new ArrayList<>();
        for (StrategyConfig cfg : req.getStrategies()) {
            results.add(runOneStrategy(req, cfg, candles));
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
                .bestStrategyLabel(bestLabel)
                .results(results)
                .build();
    }

    // ─── Per-strategy simulation ───────────────────────────────────────────────

    private StrategyRunResult runOneStrategy(BacktestRequest req, StrategyConfig cfg, List<CandleDto> candles) {
        String instanceId = "BT-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase();
        String label = resolveLabel(cfg);
        Map<String, String> params = cfg.getParameters() != null ? cfg.getParameters() : Map.of();

        StrategyLogic logic = strategyRegistry.resolve(cfg.getStrategyType());

        List<TradeEntry> trades = new ArrayList<>();
        BigDecimal runningCapital = req.getInitialCapital();
        BigDecimal peak = runningCapital;
        double maxDrawdown = 0.0;

        // Position state
        boolean      inPosition  = false;
        BigDecimal   entryPrice  = null;
        CandleDto    entryCandle = null;

        try {
            for (CandleDto candle : candles) {
                StrategyContext ctx = StrategyContext.builder()
                        .instanceId(instanceId)
                        .strategyType(cfg.getStrategyType())
                        .userId(req.getUserId())
                        .brokerName(req.getBrokerName())
                        .symbol(req.getSymbol().toUpperCase())
                        .exchange(req.getExchange().toUpperCase())
                        .product(req.getProduct())
                        .quantity(req.getQuantity())
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

                if (!inPosition && result.isBuy()) {
                    // Enter long
                    inPosition  = true;
                    entryPrice  = candle.close();
                    entryCandle = candle;

                } else if (inPosition && result.isSell()) {
                    // Exit long
                    BigDecimal exitPrice = candle.close();
                    TradeEntry trade = buildTrade(entryCandle, candle, entryPrice, exitPrice, req.getQuantity(), runningCapital);
                    trades.add(trade);
                    runningCapital = trade.getRunningCapital();

                    // Drawdown tracking
                    peak = peak.max(runningCapital);
                    if (peak.compareTo(BigDecimal.ZERO) > 0) {
                        double dd = peak.subtract(runningCapital).divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                        maxDrawdown = Math.max(maxDrawdown, dd);
                    }

                    inPosition  = false;
                    entryPrice  = null;
                    entryCandle = null;
                }
            }

            // Force-close open position at last candle
            if (inPosition && !candles.isEmpty()) {
                CandleDto last = candles.get(candles.size() - 1);
                TradeEntry trade = buildTrade(entryCandle, last, entryPrice, last.close(), req.getQuantity(), runningCapital);
                trades.add(trade);
                runningCapital = trade.getRunningCapital();
                peak = peak.max(runningCapital);
                if (peak.compareTo(BigDecimal.ZERO) > 0) {
                    double dd = peak.subtract(runningCapital).divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                    maxDrawdown = Math.max(maxDrawdown, dd);
                }
            }

        } finally {
            // Always clean up isolated backtest state
            logic.onInstanceRemoved(instanceId);
        }

        Metrics metrics = computeMetrics(trades, req.getInitialCapital(), runningCapital, maxDrawdown, params, cfg.getStrategyType());

        log.info("Backtest [{}]: {} trades, winRate={}%, totalPnl={}, return={}%",
                label, metrics.getTotalTrades(), metrics.getWinRate(),
                metrics.getTotalPnl(), metrics.getTotalReturnPct());

        return StrategyRunResult.builder()
                .strategyType(cfg.getStrategyType())
                .label(label)
                .parameters(params)
                .metrics(metrics)
                .trades(trades)
                .build();
    }

    // ─── Trade builder ─────────────────────────────────────────────────────────

    private TradeEntry buildTrade(CandleDto entry, CandleDto exit,
                                  BigDecimal entryPrice, BigDecimal exitPrice,
                                  int qty, BigDecimal capitalBefore) {
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
                .build();
    }

    // ─── Metrics computation ───────────────────────────────────────────────────

    private Metrics computeMetrics(List<TradeEntry> trades, BigDecimal initialCapital,
                                   BigDecimal finalCapital, double maxDrawdown,
                                   Map<String, String> params, String strategyType) {
        if (trades.isEmpty()) {
            return Metrics.builder()
                    .totalTrades(0).winningTrades(0).losingTrades(0)
                    .winRate(0).totalPnl(BigDecimal.ZERO)
                    .initialCapital(initialCapital).finalCapital(initialCapital)
                    .totalReturnPct(0).maxDrawdownPct(0).profitFactor(0)
                    .avgWin(BigDecimal.ZERO).avgLoss(BigDecimal.ZERO)
                    .bestTrade(BigDecimal.ZERO).worstTrade(BigDecimal.ZERO)
                    .sharpeRatio(0).warmupCandles(inferWarmup(params, strategyType))
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
                true   // persist fetched candles in Data Engine cache
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
