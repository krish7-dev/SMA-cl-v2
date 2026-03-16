package com.sma.strategyengine.service;

import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import com.sma.strategyengine.client.DataEngineClient.HistoryRequest;
import com.sma.strategyengine.model.request.BacktestRequest;
import com.sma.strategyengine.model.request.BacktestRequest.PatternConfig;
import com.sma.strategyengine.model.request.BacktestRequest.RegimeConfig;
import com.sma.strategyengine.model.request.BacktestRequest.RiskConfig;
import com.sma.strategyengine.model.request.BacktestRequest.ScoreConfig;
import com.sma.strategyengine.model.request.BacktestRequest.StrategyConfig;
import com.sma.strategyengine.model.response.BacktestResult;
import com.sma.strategyengine.model.response.BacktestResult.Metrics;
import com.sma.strategyengine.model.response.BacktestResult.StrategyRunResult;
import com.sma.strategyengine.model.response.BacktestResult.TradeEntry;
import com.sma.strategyengine.strategy.PositionDirection;
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
 * <h3>Long-only mode (allowShorting = false, default)</h3>
 * <pre>
 *   FLAT  + BUY  signal → enter LONG at candle close
 *   LONG  + SELL signal → exit at candle close → FLAT
 *   End of data: force-close any open LONG at last candle close.
 * </pre>
 *
 * <h3>Long-short mode (allowShorting = true)</h3>
 * <pre>
 *   FLAT  + BUY  signal → enter LONG at candle close
 *   FLAT  + SELL signal → enter SHORT at candle close
 *   LONG  + SELL signal → exit LONG → FLAT, then enter SHORT (reversal on same close)
 *   SHORT + BUY  signal → cover SHORT → FLAT, then enter LONG (reversal on same close)
 *   End of data: force-close any open position at last candle close.
 *
 *   Short PnL = (entryPrice − exitPrice) × qty   (profit when price falls)
 *   Short SL  = candle HIGH ≥ slPrice             (price moved against us)
 *   Short TP  = candle LOW  ≤ tpPrice             (price moved in our favour)
 * </pre>
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

        log.info("Backtest: {} candles for {}/{}, {} strategy configuration(s), allowShorting={}",
                candles.size(), req.getSymbol(), req.getExchange(), req.getStrategies().size(), req.isAllowShorting());

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

        // 3. Pre-compute market regimes if enabled
        RegimeConfig regimeCfg = req.getRegimeConfig();
        boolean regimeOn = regimeCfg != null && regimeCfg.isEnabled();
        MarketRegimeDetector.Regime[] regimes = null;
        if (regimeOn && !candles.isEmpty()) {
            int sz = candles.size();
            double[] H = new double[sz], L = new double[sz], C = new double[sz];
            for (int i = 0; i < sz; i++) {
                CandleDto cd = candles.get(i);
                H[i] = cd.high()  != null ? cd.high() .doubleValue() : 0;
                L[i] = cd.low()   != null ? cd.low()  .doubleValue() : 0;
                C[i] = cd.close() != null ? cd.close().doubleValue() : 0;
            }
            regimes = MarketRegimeDetector.computeAll(H, L, C,
                    regimeCfg.getAdxPeriod(), regimeCfg.getAtrPeriod(),
                    regimeCfg.getAdxTrendThreshold(),
                    regimeCfg.getAtrVolatilePct(), regimeCfg.getAtrCompressionPct());
            log.info("Backtest: regime detection ON (adxPeriod={}, atrPeriod={}, trendThreshold={})",
                    regimeCfg.getAdxPeriod(), regimeCfg.getAtrPeriod(), regimeCfg.getAdxTrendThreshold());
        }

        // 4. Run each strategy config
        final int qty = resolvedQty;
        final MarketRegimeDetector.Regime[] finalRegimes = regimes;
        List<StrategyRunResult> results = new ArrayList<>();

        // When regime detection is ON and at least one strategy has activeRegimes configured,
        // prepend a combined regime-switched result (one capital pool, one P&L).
        if (regimeOn && finalRegimes != null) {
            List<StrategyConfig> cfgsWithRegimes = req.getStrategies().stream()
                    .filter(cfg -> cfg.getActiveRegimes() != null && !cfg.getActiveRegimes().isEmpty())
                    .collect(java.util.stream.Collectors.toList());
            if (!cfgsWithRegimes.isEmpty()) {
                results.add(runRegimeSwitched(req, cfgsWithRegimes, candles, qty, finalRegimes));
            }
        }

        // When score config is enabled, prepend a score-based combined result
        // (all strategies compete per candle; highest scorer above threshold enters).
        ScoreConfig scoreCfg = req.getScoreConfig();
        if (scoreCfg != null && scoreCfg.isEnabled() && req.getStrategies().size() >= 1) {
            results.add(0, runScoreSwitched(req, req.getStrategies(), candles, qty, finalRegimes));
        }

        for (StrategyConfig cfg : req.getStrategies()) {
            results.add(runOneStrategy(req, cfg, candles, qty, finalRegimes));
        }

        // 5. Find best by totalPnl
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

    private StrategyRunResult runOneStrategy(BacktestRequest req, StrategyConfig cfg,
                                             List<CandleDto> candles, int resolvedQty,
                                             MarketRegimeDetector.Regime[] regimes) {
        String instanceId = "BT-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase();
        String label = resolveLabel(cfg);
        Map<String, String> params = cfg.getParameters() != null ? cfg.getParameters() : Map.of();

        StrategyLogic logic = strategyRegistry.resolve(cfg.getStrategyType());
        boolean allowShorting = req.isAllowShorting();

        // ── Pattern confirmation config ───────────────────────────────────────
        PatternConfig pc           = req.getPatternConfig();
        boolean       patternOn    = pc != null && pc.isEnabled();
        double        pMinWick     = patternOn ? pc.getMinWickRatio() : 2.0;
        double        pMaxBody     = patternOn ? pc.getMaxBodyPct()   : 0.35;
        Set<String>   buyConfirm   = patternOn && pc.getBuyConfirmPatterns()  != null
                ? new HashSet<>(pc.getBuyConfirmPatterns())  : Set.of();
        Set<String>   sellConfirm  = patternOn && pc.getSellConfirmPatterns() != null
                ? new HashSet<>(pc.getSellConfirmPatterns()) : Set.of();

        double[] patPrev2 = null;
        double[] patPrev1 = null;

        // ── Regime filter config ─────────────────────────────────────────────
        Set<String> activeRegimeSet = (cfg.getActiveRegimes() != null && !cfg.getActiveRegimes().isEmpty())
                ? new HashSet<>(cfg.getActiveRegimes()) : Set.of();
        boolean regimeFilterOn = regimes != null && !activeRegimeSet.isEmpty();

        // ── Risk config ──────────────────────────────────────────────────────
        RiskConfig rc     = req.getRiskConfig();
        boolean    riskOn = rc != null && rc.isEnabled();

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
        PositionDirection direction     = PositionDirection.FLAT;
        BigDecimal        entryPrice    = null;
        CandleDto         entryCandle   = null;
        List<String>      entryPatterns = List.of();
        String            entryRegime   = null;
        BigDecimal        slPrice       = null;
        BigDecimal        tpPrice       = null;
        int               tradeQty      = resolvedQty;

        // ── Risk state ───────────────────────────────────────────────────────
        int        cooldownRemaining = 0;
        LocalDate  currentDay        = null;
        BigDecimal dailyLossStart    = runningCapital;
        int        slExits = 0, tpExits = 0, dailyCapHalts = 0;

        try {
            for (int candleIdx = 0; candleIdx < candles.size(); candleIdx++) {
                CandleDto candle = candles.get(candleIdx);
                MarketRegimeDetector.Regime currentRegime = regimes != null ? regimes[candleIdx] : null;
                boolean regimeAllowed = !regimeFilterOn || (currentRegime != null && activeRegimeSet.contains(currentRegime.name()));
                String regimeName = currentRegime != null ? currentRegime.name() : null;

                // ── Day boundary reset ───────────────────────────────────────
                if (riskOn && candle.openTime() != null) {
                    LocalDate candleDay = candle.openTime().toLocalDate();
                    if (!candleDay.equals(currentDay)) {
                        currentDay     = candleDay;
                        dailyLossStart = runningCapital;
                    }
                }

                // ── Always evaluate strategy (maintains indicator warmup) ────
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
                        .currentDirection(direction)
                        .allowShorting(allowShorting)
                        .candleOpenTime(candle.openTime() != null ? candle.openTime().toInstant(ZoneOffset.UTC) : null)
                        .candleOpen(candle.open())
                        .candleHigh(candle.high())
                        .candleLow(candle.low())
                        .candleClose(candle.close())
                        .candleVolume(candle.volume() != null ? candle.volume() : 0L)
                        .params(params)
                        .build();

                StrategyResult result = logic.evaluate(ctx);

                // ── Detect candle patterns ───────────────────────────────────
                List<String> detectedPatterns = List.of();
                if (candle.open() != null && candle.high() != null
                        && candle.low() != null && candle.close() != null) {
                    double cO = candle.open() .doubleValue();
                    double cH = candle.high() .doubleValue();
                    double cL = candle.low()  .doubleValue();
                    double cC = candle.close().doubleValue();
                    detectedPatterns = CandlePatternDetector.detect(
                            patPrev2, patPrev1, cO, cH, cL, cC, pMinWick, pMaxBody);
                    patPrev2 = patPrev1;
                    patPrev1 = new double[]{ cO, cH, cL, cC };
                }

                final List<String> fp = detectedPatterns;
                boolean patOkBuy  = buyConfirm.isEmpty()  || fp.stream().anyMatch(buyConfirm::contains);
                boolean patOkSell = sellConfirm.isEmpty() || fp.stream().anyMatch(sellConfirm::contains);

                // ── In-position exit checks ──────────────────────────────────
                if (direction != PositionDirection.FLAT) {
                    BigDecimal exitPrice = null;
                    String     exitReason = null;

                    if (riskOn) {
                        if (direction == PositionDirection.LONG) {
                            // SL: candle low ≤ slPrice
                            if (slPrice != null && candle.low() != null
                                    && candle.low().compareTo(slPrice) <= 0) {
                                exitPrice  = slPrice;
                                exitReason = "STOP_LOSS";
                                slExits++;
                            }
                            // TP: candle high ≥ tpPrice
                            else if (tpPrice != null && candle.high() != null
                                    && candle.high().compareTo(tpPrice) >= 0) {
                                exitPrice  = tpPrice;
                                exitReason = "TAKE_PROFIT";
                                tpExits++;
                            }
                        } else { // SHORT
                            // SL: candle high ≥ slPrice (price rose against us)
                            if (slPrice != null && candle.high() != null
                                    && candle.high().compareTo(slPrice) >= 0) {
                                exitPrice  = slPrice;
                                exitReason = "STOP_LOSS";
                                slExits++;
                            }
                            // TP: candle low ≤ tpPrice (price fell in our favour)
                            else if (tpPrice != null && candle.low() != null
                                    && candle.low().compareTo(tpPrice) <= 0) {
                                exitPrice  = tpPrice;
                                exitReason = "TAKE_PROFIT";
                                tpExits++;
                            }
                        }
                    }

                    // Strategy signal exit (only if not already exited via SL/TP)
                    if (exitPrice == null) {
                        if (direction == PositionDirection.LONG && result.isSell() && patOkSell) {
                            exitPrice  = candle.close();
                            exitReason = "SIGNAL";
                        } else if (direction == PositionDirection.SHORT && result.isBuy() && patOkBuy) {
                            exitPrice  = candle.close();
                            exitReason = "SIGNAL";
                        }
                    }

                    if (exitPrice != null) {
                        PositionDirection closedDirection = direction;
                        TradeEntry trade = buildTrade(entryCandle, candle, entryPrice, exitPrice,
                                tradeQty, runningCapital, exitReason, closedDirection, entryPatterns, entryRegime);
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

                        direction     = PositionDirection.FLAT;
                        entryPrice    = null;
                        entryCandle   = null;
                        entryPatterns = List.of();
                        entryRegime   = null;
                        slPrice       = null;
                        tpPrice       = null;

                        // ── Reversal: immediately enter opposite on same candle close ──
                        // Only on SIGNAL exits (not SL/TP) and only if allowShorting
                        if (allowShorting && "SIGNAL".equals(exitReason) && candle.close() != null
                                && candle.close().compareTo(BigDecimal.ZERO) > 0) {
                            if (closedDirection == PositionDirection.LONG && result.isSell() && patOkSell) {
                                // Reversed LONG → SHORT
                                direction     = PositionDirection.SHORT;
                                entryPrice    = candle.close();
                                entryCandle   = candle;
                                entryPatterns = detectedPatterns;
                                entryRegime   = regimeName;
                                slPrice       = computeSl(entryPrice, PositionDirection.SHORT, slFrac);
                                tpPrice       = computeTp(entryPrice, PositionDirection.SHORT, tpFrac);
                                tradeQty      = resolvedQty;
                            } else if (closedDirection == PositionDirection.SHORT && result.isBuy() && patOkBuy) {
                                // Reversed SHORT → LONG
                                direction     = PositionDirection.LONG;
                                entryPrice    = candle.close();
                                entryCandle   = candle;
                                entryPatterns = detectedPatterns;
                                entryRegime   = regimeName;
                                slPrice       = computeSl(entryPrice, PositionDirection.LONG, slFrac);
                                tpPrice       = computeTp(entryPrice, PositionDirection.LONG, tpFrac);
                                tradeQty      = resolvedQty;
                            }
                        }
                    }

                // ── Flat — entry check ───────────────────────────────────────
                } else {
                    if (riskOn) {
                        if (cooldownRemaining > 0) {
                            cooldownRemaining--;
                            continue;
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
                        if (!dailyCapHit && candle.close() != null
                                && candle.close().compareTo(BigDecimal.ZERO) > 0) {

                            if (result.isBuy() && patOkBuy && regimeAllowed) {
                                tradeQty = sizeQty(resolvedQty, runningCapital, candle.close(), riskFrac, slFrac);
                                direction     = PositionDirection.LONG;
                                entryPrice    = candle.close();
                                entryCandle   = candle;
                                entryPatterns = detectedPatterns;
                                entryRegime   = regimeName;
                                slPrice       = computeSl(entryPrice, PositionDirection.LONG, slFrac);
                                tpPrice       = computeTp(entryPrice, PositionDirection.LONG, tpFrac);
                            } else if (allowShorting && result.isSell() && patOkSell && regimeAllowed) {
                                tradeQty = sizeQty(resolvedQty, runningCapital, candle.close(), riskFrac, slFrac);
                                direction     = PositionDirection.SHORT;
                                entryPrice    = candle.close();
                                entryCandle   = candle;
                                entryPatterns = detectedPatterns;
                                entryRegime   = regimeName;
                                slPrice       = computeSl(entryPrice, PositionDirection.SHORT, slFrac);
                                tpPrice       = computeTp(entryPrice, PositionDirection.SHORT, tpFrac);
                            }
                        }
                    } else {
                        // Risk OFF — signal-only logic
                        if (result.isBuy() && patOkBuy && regimeAllowed) {
                            direction     = PositionDirection.LONG;
                            entryPrice    = candle.close();
                            entryCandle   = candle;
                            entryPatterns = detectedPatterns;
                            entryRegime   = regimeName;
                            tradeQty      = resolvedQty;
                        } else if (allowShorting && result.isSell() && patOkSell && regimeAllowed) {
                            direction     = PositionDirection.SHORT;
                            entryPrice    = candle.close();
                            entryCandle   = candle;
                            entryPatterns = detectedPatterns;
                            entryRegime   = regimeName;
                            tradeQty      = resolvedQty;
                        }
                    }
                }
            }

            // Force-close any open position at last candle
            if (direction != PositionDirection.FLAT && !candles.isEmpty()) {
                CandleDto last = candles.get(candles.size() - 1);
                TradeEntry trade = buildTrade(entryCandle, last, entryPrice, last.close(),
                        tradeQty, runningCapital, "END_OF_BACKTEST", direction, entryPatterns, entryRegime);
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

        log.info("Backtest [{}]: {} trades, winRate={}%, totalPnl={}, return={}%, allowShorting={}{}",
                label, metrics.getTotalTrades(), metrics.getWinRate(),
                metrics.getTotalPnl(), metrics.getTotalReturnPct(), allowShorting,
                riskOn ? " [risk: SL=" + slExits + " TP=" + tpExits + " capHalts=" + dailyCapHalts + "]" : "");

        return StrategyRunResult.builder()
                .strategyType(cfg.getStrategyType())
                .label(label)
                .parameters(params)
                .metrics(metrics)
                .trades(trades)
                .build();
    }

    // ─── Regime-Switched combined simulation ──────────────────────────────────
    //
    // Runs all strategy logics per candle simultaneously (each maintaining its own
    // warmup/state), but only acts on the signal from the strategy assigned to the
    // current regime. One capital pool → one combined P&L.

    private StrategyRunResult runRegimeSwitched(BacktestRequest req, List<StrategyConfig> cfgs,
                                                List<CandleDto> candles, int resolvedQty,
                                                MarketRegimeDetector.Regime[] regimes) {
        // Regime → first matching config (order in list wins)
        Map<String, StrategyConfig> regimeMap = new LinkedHashMap<>();
        for (StrategyConfig cfg : cfgs) {
            if (cfg.getActiveRegimes() != null) {
                for (String r : cfg.getActiveRegimes()) {
                    regimeMap.putIfAbsent(r.toUpperCase(), cfg);
                }
            }
        }

        // One StrategyLogic instance per config object (IdentityHashMap preserves separation)
        Map<StrategyConfig, StrategyLogic>        cfgLogic    = new java.util.IdentityHashMap<>();
        Map<StrategyConfig, String>               cfgInstance = new java.util.IdentityHashMap<>();
        Map<StrategyConfig, Map<String, String>>  cfgParams   = new java.util.IdentityHashMap<>();
        for (StrategyConfig cfg : cfgs) {
            if (!cfgLogic.containsKey(cfg)) {
                cfgLogic.put(cfg, strategyRegistry.resolve(cfg.getStrategyType()));
                cfgInstance.put(cfg, "BT-RS-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10).toUpperCase());
                cfgParams.put(cfg, cfg.getParameters() != null ? cfg.getParameters() : Map.of());
            }
        }

        boolean allowShorting = req.isAllowShorting();

        // Pattern config
        PatternConfig pc         = req.getPatternConfig();
        boolean       patternOn  = pc != null && pc.isEnabled();
        double        pMinWick   = patternOn ? pc.getMinWickRatio() : 2.0;
        double        pMaxBody   = patternOn ? pc.getMaxBodyPct()   : 0.35;
        Set<String>   buyConfirm = patternOn && pc.getBuyConfirmPatterns()  != null
                ? new HashSet<>(pc.getBuyConfirmPatterns())  : Set.of();
        Set<String>   sellConfirm = patternOn && pc.getSellConfirmPatterns() != null
                ? new HashSet<>(pc.getSellConfirmPatterns()) : Set.of();
        double[] patPrev2 = null, patPrev1 = null;

        // Risk config
        RiskConfig rc     = req.getRiskConfig();
        boolean    riskOn = rc != null && rc.isEnabled();
        BigDecimal slFrac   = fracOrNull(rc == null ? null : rc.getStopLossPct());
        BigDecimal tpFrac   = fracOrNull(rc == null ? null : rc.getTakeProfitPct());
        BigDecimal riskFrac = (riskOn && slFrac != null) ? fracOrNull(rc.getMaxRiskPerTradePct()) : null;
        BigDecimal capFrac  = fracOrNull(rc == null ? null : rc.getDailyLossCapPct());

        // Capital / drawdown / position state
        List<TradeEntry>  trades        = new ArrayList<>();
        BigDecimal        runningCapital = req.getInitialCapital();
        BigDecimal        peak           = runningCapital;
        double            maxDrawdown    = 0.0;
        PositionDirection direction      = PositionDirection.FLAT;
        BigDecimal        entryPrice     = null;
        CandleDto         entryCandle    = null;
        List<String>      entryPatterns  = List.of();
        String            entryRegime    = null;
        BigDecimal        slPrice        = null;
        BigDecimal        tpPrice        = null;
        int               tradeQty       = resolvedQty;
        int               cooldownRemaining = 0;
        LocalDate         currentDay        = null;
        BigDecimal        dailyLossStart    = runningCapital;
        int               slExits = 0, tpExits = 0, dailyCapHalts = 0;

        try {
            for (int ci = 0; ci < candles.size(); ci++) {
                CandleDto candle       = candles.get(ci);
                String    regimeName   = regimes[ci].name();
                StrategyConfig active  = regimeMap.get(regimeName);

                // Day boundary reset
                if (riskOn && candle.openTime() != null) {
                    LocalDate day = candle.openTime().toLocalDate();
                    if (!day.equals(currentDay)) { currentDay = day; dailyLossStart = runningCapital; }
                }

                // ── Evaluate ALL strategy logics (maintains each one's warmup state) ─
                Map<StrategyConfig, StrategyResult> allResults = new java.util.IdentityHashMap<>();
                for (StrategyConfig cfg : cfgs) {
                    StrategyContext ctx = StrategyContext.builder()
                            .instanceId(cfgInstance.get(cfg))
                            .strategyType(cfg.getStrategyType())
                            .userId(req.getUserId()).brokerName(req.getBrokerName())
                            .symbol(req.getSymbol().toUpperCase()).exchange(req.getExchange().toUpperCase())
                            .product(req.getProduct()).quantity(tradeQty).orderType("MARKET")
                            .currentDirection(direction).allowShorting(allowShorting)
                            .candleOpenTime(candle.openTime() != null ? candle.openTime().toInstant(ZoneOffset.UTC) : null)
                            .candleOpen(candle.open()).candleHigh(candle.high())
                            .candleLow(candle.low()).candleClose(candle.close())
                            .candleVolume(candle.volume() != null ? candle.volume() : 0L)
                            .params(cfgParams.get(cfg))
                            .build();
                    allResults.put(cfg, cfgLogic.get(cfg).evaluate(ctx));
                }

                StrategyResult activeResult = active != null ? allResults.get(active) : null;

                // Candle patterns
                List<String> detectedPatterns = List.of();
                if (candle.open() != null && candle.high() != null && candle.low() != null && candle.close() != null) {
                    double cO = candle.open().doubleValue(), cH = candle.high().doubleValue();
                    double cL = candle.low().doubleValue(),  cC = candle.close().doubleValue();
                    detectedPatterns = CandlePatternDetector.detect(patPrev2, patPrev1, cO, cH, cL, cC, pMinWick, pMaxBody);
                    patPrev2 = patPrev1;
                    patPrev1 = new double[]{ cO, cH, cL, cC };
                }
                final List<String> fp = detectedPatterns;
                boolean patOkBuy  = buyConfirm.isEmpty()  || fp.stream().anyMatch(buyConfirm::contains);
                boolean patOkSell = sellConfirm.isEmpty() || fp.stream().anyMatch(sellConfirm::contains);

                // ── In-position exit checks ───────────────────────────────────────
                if (direction != PositionDirection.FLAT) {
                    BigDecimal exitPrice = null;
                    String     exitReason = null;

                    if (riskOn) {
                        if (direction == PositionDirection.LONG) {
                            if (slPrice != null && candle.low() != null && candle.low().compareTo(slPrice) <= 0) {
                                exitPrice = slPrice; exitReason = "STOP_LOSS"; slExits++;
                            } else if (tpPrice != null && candle.high() != null && candle.high().compareTo(tpPrice) >= 0) {
                                exitPrice = tpPrice; exitReason = "TAKE_PROFIT"; tpExits++;
                            }
                        } else { // SHORT
                            if (slPrice != null && candle.high() != null && candle.high().compareTo(slPrice) >= 0) {
                                exitPrice = slPrice; exitReason = "STOP_LOSS"; slExits++;
                            } else if (tpPrice != null && candle.low() != null && candle.low().compareTo(tpPrice) <= 0) {
                                exitPrice = tpPrice; exitReason = "TAKE_PROFIT"; tpExits++;
                            }
                        }
                    }

                    // Signal exits
                    if (exitPrice == null && activeResult != null) {
                        if (direction == PositionDirection.LONG && activeResult.isSell() && patOkSell) {
                            exitPrice = candle.close(); exitReason = "SIGNAL";
                        } else if (direction == PositionDirection.SHORT && activeResult.isBuy() && patOkBuy) {
                            exitPrice = candle.close(); exitReason = "SIGNAL";
                        }
                    }
                    // Regime changed to one with no assigned strategy → force exit
                    if (exitPrice == null && active == null) {
                        exitPrice = candle.close(); exitReason = "REGIME_CHANGE";
                    }

                    if (exitPrice != null) {
                        PositionDirection closedDirection = direction;
                        TradeEntry trade = buildTrade(entryCandle, candle, entryPrice, exitPrice,
                                tradeQty, runningCapital, exitReason, closedDirection, entryPatterns, entryRegime);
                        trades.add(trade);
                        runningCapital = trade.getRunningCapital();
                        peak = peak.max(runningCapital);
                        if (peak.compareTo(BigDecimal.ZERO) > 0) {
                            double dd = peak.subtract(runningCapital).divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                            maxDrawdown = Math.max(maxDrawdown, dd);
                        }
                        if (riskOn && rc.getCooldownCandles() > 0 && trade.getPnl().compareTo(BigDecimal.ZERO) <= 0) {
                            cooldownRemaining = rc.getCooldownCandles();
                        }
                        direction = PositionDirection.FLAT;
                        entryPrice = null; entryCandle = null;
                        entryPatterns = List.of(); entryRegime = null; slPrice = null; tpPrice = null;

                        // Reversal on same candle (SIGNAL exits only, regime-switched)
                        if (allowShorting && "SIGNAL".equals(exitReason) && activeResult != null
                                && candle.close() != null && candle.close().compareTo(BigDecimal.ZERO) > 0) {
                            if (closedDirection == PositionDirection.LONG && activeResult.isSell() && patOkSell) {
                                direction     = PositionDirection.SHORT;
                                entryPrice    = candle.close(); entryCandle = candle;
                                entryPatterns = detectedPatterns; entryRegime = regimeName;
                                slPrice = computeSl(entryPrice, PositionDirection.SHORT, slFrac);
                                tpPrice = computeTp(entryPrice, PositionDirection.SHORT, tpFrac);
                                tradeQty = resolvedQty;
                            } else if (closedDirection == PositionDirection.SHORT && activeResult.isBuy() && patOkBuy) {
                                direction     = PositionDirection.LONG;
                                entryPrice    = candle.close(); entryCandle = candle;
                                entryPatterns = detectedPatterns; entryRegime = regimeName;
                                slPrice = computeSl(entryPrice, PositionDirection.LONG, slFrac);
                                tpPrice = computeTp(entryPrice, PositionDirection.LONG, tpFrac);
                                tradeQty = resolvedQty;
                            }
                        }
                    }

                // ── Entry check ───────────────────────────────────────────────────
                } else if (activeResult != null) {
                    if (riskOn) {
                        if (cooldownRemaining > 0) { cooldownRemaining--; continue; }
                        boolean dailyCapHit = false;
                        if (capFrac != null && dailyLossStart.compareTo(BigDecimal.ZERO) > 0) {
                            BigDecimal lost = dailyLossStart.subtract(runningCapital).divide(dailyLossStart, 8, RoundingMode.HALF_UP);
                            if (lost.compareTo(capFrac) >= 0) { dailyCapHit = true; dailyCapHalts++; }
                        }
                        if (!dailyCapHit && candle.close() != null && candle.close().compareTo(BigDecimal.ZERO) > 0) {
                            if (activeResult.isBuy() && patOkBuy) {
                                tradeQty = sizeQty(resolvedQty, runningCapital, candle.close(), riskFrac, slFrac);
                                direction = PositionDirection.LONG;
                                entryPrice = candle.close(); entryCandle = candle;
                                entryPatterns = detectedPatterns; entryRegime = regimeName;
                                slPrice = computeSl(entryPrice, PositionDirection.LONG, slFrac);
                                tpPrice = computeTp(entryPrice, PositionDirection.LONG, tpFrac);
                            } else if (allowShorting && activeResult.isSell() && patOkSell) {
                                tradeQty = sizeQty(resolvedQty, runningCapital, candle.close(), riskFrac, slFrac);
                                direction = PositionDirection.SHORT;
                                entryPrice = candle.close(); entryCandle = candle;
                                entryPatterns = detectedPatterns; entryRegime = regimeName;
                                slPrice = computeSl(entryPrice, PositionDirection.SHORT, slFrac);
                                tpPrice = computeTp(entryPrice, PositionDirection.SHORT, tpFrac);
                            }
                        }
                    } else {
                        if (activeResult.isBuy() && patOkBuy) {
                            direction = PositionDirection.LONG;
                            entryPrice = candle.close(); entryCandle = candle;
                            entryPatterns = detectedPatterns; entryRegime = regimeName; tradeQty = resolvedQty;
                        } else if (allowShorting && activeResult.isSell() && patOkSell) {
                            direction = PositionDirection.SHORT;
                            entryPrice = candle.close(); entryCandle = candle;
                            entryPatterns = detectedPatterns; entryRegime = regimeName; tradeQty = resolvedQty;
                        }
                    }
                }
            }

            // Force-close open position at last candle
            if (direction != PositionDirection.FLAT && !candles.isEmpty()) {
                CandleDto last = candles.get(candles.size() - 1);
                TradeEntry trade = buildTrade(entryCandle, last, entryPrice, last.close(),
                        tradeQty, runningCapital, "END_OF_BACKTEST", direction, entryPatterns, entryRegime);
                trades.add(trade);
                runningCapital = trade.getRunningCapital();
                peak = peak.max(runningCapital);
                if (peak.compareTo(BigDecimal.ZERO) > 0) {
                    double dd = peak.subtract(runningCapital).divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                    maxDrawdown = Math.max(maxDrawdown, dd);
                }
            }

        } finally {
            cfgs.forEach(cfg -> {
                StrategyLogic l = cfgLogic.get(cfg);
                if (l != null) l.onInstanceRemoved(cfgInstance.get(cfg));
            });
        }

        // Build a readable label: "Regime-Switched [T:SMA V:RSI ...]"
        StringBuilder labelB = new StringBuilder("Regime-Switched [");
        regimeMap.forEach((r, cfg) -> labelB.append(r.charAt(0)).append(':').append(resolveLabel(cfg)).append(' '));
        String label = labelB.toString().trim() + "]";

        Metrics metrics = computeMetrics(trades, req.getInitialCapital(), runningCapital,
                maxDrawdown, Map.of(), "REGIME_SWITCHED", slExits, tpExits, dailyCapHalts);

        log.info("Backtest [{}]: {} trades, winRate={}%, totalPnl={}", label,
                metrics.getTotalTrades(), metrics.getWinRate(), metrics.getTotalPnl());

        return StrategyRunResult.builder()
                .strategyType("REGIME_SWITCHED")
                .label(label)
                .parameters(Map.of())
                .metrics(metrics)
                .trades(trades)
                .build();
    }

    // ─── Score-Switched combined simulation ───────────────────────────────────
    //
    // All strategy logics are evaluated every candle (to maintain warmup state).
    // The strategy with the highest quality score above the threshold is chosen.
    // One shared capital pool → one combined P&L. Score breakdown stored per trade.

    private StrategyRunResult runScoreSwitched(BacktestRequest req, List<StrategyConfig> cfgs,
                                               List<CandleDto> candles, int resolvedQty,
                                               MarketRegimeDetector.Regime[] regimes) {
        ScoreConfig sc        = req.getScoreConfig();
        double      minScore  = sc != null ? sc.getMinScoreThreshold() : 30.0;
        String      instrType = req.getInstrumentType() != null ? req.getInstrumentType() : "STOCK";
        boolean     allowShorting = req.isAllowShorting();

        // One StrategyLogic + scorer per config
        Map<StrategyConfig, StrategyLogic>        cfgLogic    = new java.util.IdentityHashMap<>();
        Map<StrategyConfig, String>               cfgInstance = new java.util.IdentityHashMap<>();
        Map<StrategyConfig, Map<String, String>>  cfgParams   = new java.util.IdentityHashMap<>();
        Map<StrategyConfig, StrategyScorer>       cfgScorer   = new java.util.IdentityHashMap<>();
        for (StrategyConfig cfg : cfgs) {
            cfgLogic.put(cfg, strategyRegistry.resolve(cfg.getStrategyType()));
            cfgInstance.put(cfg, "BT-SC-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10).toUpperCase());
            cfgParams.put(cfg, cfg.getParameters() != null ? cfg.getParameters() : Map.of());
            cfgScorer.put(cfg, new StrategyScorer());
        }

        // Pattern config
        PatternConfig pc        = req.getPatternConfig();
        boolean       patternOn = pc != null && pc.isEnabled();
        double        pMinWick  = patternOn ? pc.getMinWickRatio() : 2.0;
        double        pMaxBody  = patternOn ? pc.getMaxBodyPct()   : 0.35;
        Set<String>   buyConfirm  = patternOn && pc.getBuyConfirmPatterns()  != null
                ? new HashSet<>(pc.getBuyConfirmPatterns())  : Set.of();
        Set<String>   sellConfirm = patternOn && pc.getSellConfirmPatterns() != null
                ? new HashSet<>(pc.getSellConfirmPatterns()) : Set.of();
        double[] patPrev2 = null, patPrev1 = null;

        // Risk config
        RiskConfig rc     = req.getRiskConfig();
        boolean    riskOn = rc != null && rc.isEnabled();
        BigDecimal slFrac   = fracOrNull(rc == null ? null : rc.getStopLossPct());
        BigDecimal tpFrac   = fracOrNull(rc == null ? null : rc.getTakeProfitPct());
        BigDecimal riskFrac = (riskOn && slFrac != null) ? fracOrNull(rc.getMaxRiskPerTradePct()) : null;
        BigDecimal capFrac  = fracOrNull(rc == null ? null : rc.getDailyLossCapPct());

        // Capital / position state
        List<TradeEntry>  trades         = new ArrayList<>();
        BigDecimal        runningCapital = req.getInitialCapital();
        BigDecimal        peak           = runningCapital;
        double            maxDrawdown    = 0.0;
        PositionDirection direction      = PositionDirection.FLAT;
        BigDecimal        entryPrice     = null;
        CandleDto         entryCandle    = null;
        List<String>      entryPatterns  = List.of();
        String            entryRegime    = null;
        String            entryStrategy  = null;   // which strategy opened this trade
        StrategyScorer.ScoreResult entryScore = null;
        BigDecimal        slPrice        = null;
        BigDecimal        tpPrice        = null;
        int               tradeQty       = resolvedQty;
        int               cooldownRemaining = 0;
        LocalDate         currentDay        = null;
        BigDecimal        dailyLossStart    = runningCapital;
        int               slExits = 0, tpExits = 0, dailyCapHalts = 0;

        try {
            for (int ci = 0; ci < candles.size(); ci++) {
                CandleDto candle     = candles.get(ci);
                String    regimeName = regimes != null ? regimes[ci].name() : null;

                // Day boundary reset
                if (riskOn && candle.openTime() != null) {
                    LocalDate day = candle.openTime().toLocalDate();
                    if (!day.equals(currentDay)) { currentDay = day; dailyLossStart = runningCapital; }
                }

                // Feed candle into all scorers (maintains rolling window regardless of signal)
                if (candle.open() != null && candle.high() != null && candle.low() != null && candle.close() != null) {
                    double cO = candle.open().doubleValue(), cH = candle.high().doubleValue();
                    double cL = candle.low().doubleValue(),  cC = candle.close().doubleValue();
                    for (StrategyScorer scorer : cfgScorer.values()) scorer.push(cO, cH, cL, cC);
                }

                // Evaluate ALL strategy logics
                Map<StrategyConfig, StrategyResult> allResults = new java.util.IdentityHashMap<>();
                for (StrategyConfig cfg : cfgs) {
                    StrategyContext ctx = StrategyContext.builder()
                            .instanceId(cfgInstance.get(cfg))
                            .strategyType(cfg.getStrategyType())
                            .userId(req.getUserId()).brokerName(req.getBrokerName())
                            .symbol(req.getSymbol().toUpperCase()).exchange(req.getExchange().toUpperCase())
                            .product(req.getProduct()).quantity(tradeQty).orderType("MARKET")
                            .currentDirection(direction).allowShorting(allowShorting)
                            .candleOpenTime(candle.openTime() != null ? candle.openTime().toInstant(ZoneOffset.UTC) : null)
                            .candleOpen(candle.open()).candleHigh(candle.high())
                            .candleLow(candle.low()).candleClose(candle.close())
                            .candleVolume(candle.volume() != null ? candle.volume() : 0L)
                            .params(cfgParams.get(cfg))
                            .build();
                    allResults.put(cfg, cfgLogic.get(cfg).evaluate(ctx));
                }

                // Candle patterns
                List<String> detectedPatterns = List.of();
                if (candle.open() != null && candle.high() != null && candle.low() != null && candle.close() != null) {
                    double cO = candle.open().doubleValue(), cH = candle.high().doubleValue();
                    double cL = candle.low().doubleValue(),  cC = candle.close().doubleValue();
                    detectedPatterns = CandlePatternDetector.detect(patPrev2, patPrev1, cO, cH, cL, cC, pMinWick, pMaxBody);
                    patPrev2 = patPrev1;
                    patPrev1 = new double[]{ cO, cH, cL, cC };
                }
                final List<String> fp = detectedPatterns;
                boolean patOkBuy  = buyConfirm.isEmpty()  || fp.stream().anyMatch(buyConfirm::contains);
                boolean patOkSell = sellConfirm.isEmpty() || fp.stream().anyMatch(sellConfirm::contains);

                // ── In-position: exit checks (driven by the strategy that opened the trade) ─
                if (direction != PositionDirection.FLAT) {
                    BigDecimal exitPrice = null;
                    String     exitReason = null;

                    if (riskOn) {
                        if (direction == PositionDirection.LONG) {
                            if (slPrice != null && candle.low()  != null && candle.low() .compareTo(slPrice) <= 0) { exitPrice = slPrice; exitReason = "STOP_LOSS";   slExits++; }
                            else if (tpPrice != null && candle.high() != null && candle.high().compareTo(tpPrice) >= 0) { exitPrice = tpPrice; exitReason = "TAKE_PROFIT"; tpExits++; }
                        } else {
                            if (slPrice != null && candle.high() != null && candle.high().compareTo(slPrice) >= 0) { exitPrice = slPrice; exitReason = "STOP_LOSS";   slExits++; }
                            else if (tpPrice != null && candle.low()  != null && candle.low() .compareTo(tpPrice) <= 0) { exitPrice = tpPrice; exitReason = "TAKE_PROFIT"; tpExits++; }
                        }
                    }

                    // Signal exit: use the strategy that opened this trade
                    if (exitPrice == null && entryStrategy != null) {
                        final String capturedEntryStrategy = entryStrategy;
                        StrategyConfig activeCfg = cfgs.stream()
                                .filter(c -> c.getStrategyType().equals(capturedEntryStrategy)).findFirst().orElse(null);
                        StrategyResult activeResult = activeCfg != null ? allResults.get(activeCfg) : null;
                        if (activeResult != null) {
                            if (direction == PositionDirection.LONG && activeResult.isSell() && patOkSell) {
                                exitPrice = candle.close(); exitReason = "SIGNAL";
                            } else if (direction == PositionDirection.SHORT && activeResult.isBuy() && patOkBuy) {
                                exitPrice = candle.close(); exitReason = "SIGNAL";
                            }
                        }
                    }

                    if (exitPrice != null) {
                        PositionDirection closedDirection = direction;
                        TradeEntry trade = buildScoreTrade(entryCandle, candle, entryPrice, exitPrice,
                                tradeQty, runningCapital, exitReason, closedDirection,
                                entryPatterns, entryRegime, entryStrategy, entryScore);
                        trades.add(trade);
                        runningCapital = trade.getRunningCapital();
                        peak = peak.max(runningCapital);
                        if (peak.compareTo(BigDecimal.ZERO) > 0) {
                            double dd = peak.subtract(runningCapital).divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                            maxDrawdown = Math.max(maxDrawdown, dd);
                        }
                        if (riskOn && rc.getCooldownCandles() > 0 && trade.getPnl().compareTo(BigDecimal.ZERO) <= 0) {
                            cooldownRemaining = rc.getCooldownCandles();
                        }
                        direction = PositionDirection.FLAT;
                        entryPrice = null; entryCandle = null; entryPatterns = List.of();
                        entryRegime = null; entryStrategy = null; entryScore = null;
                        slPrice = null; tpPrice = null;

                        // Reversal on same candle (SIGNAL exit only)
                        if (allowShorting && "SIGNAL".equals(exitReason) && candle.close() != null
                                && candle.close().compareTo(BigDecimal.ZERO) > 0) {
                            // Re-score for reversal direction
                            StrategyScorer.ScoreResult bestRev = null;
                            StrategyConfig bestRevCfg = null;
                            for (StrategyConfig cfg : cfgs) {
                                StrategyResult r = allResults.get(cfg);
                                boolean wantBuy  = (closedDirection == PositionDirection.SHORT);
                                if ((wantBuy && r.isBuy() && patOkBuy) || (!wantBuy && r.isSell() && patOkSell)) {
                                    StrategyScorer.ScoreResult s = cfgScorer.get(cfg).score(
                                            cfg.getStrategyType(), wantBuy, regimeName, instrType);
                                    if (s.getTotal() >= minScore && (bestRev == null || s.getTotal() > bestRev.getTotal())) {
                                        bestRev = s; bestRevCfg = cfg;
                                    }
                                }
                            }
                            if (bestRevCfg != null) {
                                boolean wantBuy = (closedDirection == PositionDirection.SHORT);
                                direction     = wantBuy ? PositionDirection.LONG : PositionDirection.SHORT;
                                entryPrice    = candle.close(); entryCandle = candle;
                                entryPatterns = detectedPatterns; entryRegime = regimeName;
                                entryStrategy = bestRevCfg.getStrategyType(); entryScore = bestRev;
                                tradeQty      = riskOn ? sizeQty(resolvedQty, runningCapital, entryPrice, riskFrac, slFrac) : resolvedQty;
                                slPrice = computeSl(entryPrice, direction, slFrac);
                                tpPrice = computeTp(entryPrice, direction, tpFrac);
                            }
                        }
                    }

                // ── Flat: score all signals, pick best ───────────────────────────────
                } else {
                    if (riskOn) {
                        if (cooldownRemaining > 0) { cooldownRemaining--; continue; }
                        boolean dailyCapHit = false;
                        if (capFrac != null && dailyLossStart.compareTo(BigDecimal.ZERO) > 0) {
                            BigDecimal lost = dailyLossStart.subtract(runningCapital).divide(dailyLossStart, 8, RoundingMode.HALF_UP);
                            if (lost.compareTo(capFrac) >= 0) { dailyCapHit = true; dailyCapHalts++; }
                        }
                        if (dailyCapHit || candle.close() == null || candle.close().compareTo(BigDecimal.ZERO) <= 0) continue;
                    }

                    // Find best-scoring signal across all strategies
                    StrategyScorer.ScoreResult bestScore = null;
                    StrategyConfig             bestCfg   = null;
                    PositionDirection          bestDir   = null;

                    for (StrategyConfig cfg : cfgs) {
                        StrategyResult r = allResults.get(cfg);
                        if (r.isBuy() && patOkBuy && candle.close() != null) {
                            StrategyScorer.ScoreResult s = cfgScorer.get(cfg).score(
                                    cfg.getStrategyType(), true, regimeName, instrType);
                            if (s.getTotal() >= minScore && (bestScore == null || s.getTotal() > bestScore.getTotal())) {
                                bestScore = s; bestCfg = cfg; bestDir = PositionDirection.LONG;
                            }
                        }
                        if (allowShorting && r.isSell() && patOkSell && candle.close() != null) {
                            StrategyScorer.ScoreResult s = cfgScorer.get(cfg).score(
                                    cfg.getStrategyType(), false, regimeName, instrType);
                            if (s.getTotal() >= minScore && (bestScore == null || s.getTotal() > bestScore.getTotal())) {
                                bestScore = s; bestCfg = cfg; bestDir = PositionDirection.SHORT;
                            }
                        }
                    }

                    if (bestCfg != null && bestDir != null && candle.close() != null) {
                        tradeQty      = riskOn ? sizeQty(resolvedQty, runningCapital, candle.close(), riskFrac, slFrac) : resolvedQty;
                        direction     = bestDir;
                        entryPrice    = candle.close(); entryCandle = candle;
                        entryPatterns = detectedPatterns; entryRegime = regimeName;
                        entryStrategy = bestCfg.getStrategyType(); entryScore = bestScore;
                        slPrice = computeSl(entryPrice, direction, slFrac);
                        tpPrice = computeTp(entryPrice, direction, tpFrac);
                    }
                }
            }

            // Force-close open position at last candle
            if (direction != PositionDirection.FLAT && !candles.isEmpty()) {
                CandleDto last = candles.get(candles.size() - 1);
                TradeEntry trade = buildScoreTrade(entryCandle, last, entryPrice, last.close(),
                        tradeQty, runningCapital, "END_OF_BACKTEST", direction,
                        entryPatterns, entryRegime, entryStrategy, entryScore);
                trades.add(trade);
                runningCapital = trade.getRunningCapital();
                peak = peak.max(runningCapital);
                if (peak.compareTo(BigDecimal.ZERO) > 0) {
                    double dd = peak.subtract(runningCapital).divide(peak, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
                    maxDrawdown = Math.max(maxDrawdown, dd);
                }
            }
        } finally {
            cfgs.forEach(cfg -> {
                StrategyLogic l = cfgLogic.get(cfg);
                if (l != null) l.onInstanceRemoved(cfgInstance.get(cfg));
            });
        }

        String label = "Score-Switched [" + cfgs.stream()
                .map(c -> c.getStrategyType()).distinct()
                .collect(java.util.stream.Collectors.joining("|")) + "]";

        Metrics metrics = computeMetrics(trades, req.getInitialCapital(), runningCapital,
                maxDrawdown, Map.of(), "SCORE_SWITCHED", slExits, tpExits, dailyCapHalts);

        log.info("Backtest [{}]: {} trades, winRate={}%, totalPnl={}, instrType={}, minScore={}",
                label, metrics.getTotalTrades(), metrics.getWinRate(), metrics.getTotalPnl(),
                instrType, minScore);

        return StrategyRunResult.builder()
                .strategyType("SCORE_SWITCHED")
                .label(label)
                .parameters(Map.of("instrType", instrType, "minScore", String.valueOf(minScore)))
                .metrics(metrics)
                .trades(trades)
                .build();
    }

    /** Variant of buildTrade that also stores selectedStrategy and scoreBreakdown. */
    private TradeEntry buildScoreTrade(CandleDto entry, CandleDto exit,
                                       BigDecimal entryPrice, BigDecimal exitPrice,
                                       int qty, BigDecimal capitalBefore, String exitReason,
                                       PositionDirection direction,
                                       List<String> entryPatterns, String regime,
                                       String selectedStrategy,
                                       StrategyScorer.ScoreResult scoreBreakdown) {
        BigDecimal pnl;
        if (direction == PositionDirection.SHORT) {
            pnl = entryPrice.subtract(exitPrice).multiply(BigDecimal.valueOf(qty)).setScale(2, RoundingMode.HALF_UP);
        } else {
            pnl = exitPrice.subtract(entryPrice).multiply(BigDecimal.valueOf(qty)).setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal notional = entryPrice.multiply(BigDecimal.valueOf(qty));
        double pnlPct = notional.compareTo(BigDecimal.ZERO) == 0 ? 0.0
                : pnl.divide(notional, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
        BigDecimal running = capitalBefore.add(pnl).setScale(2, RoundingMode.HALF_UP);

        return TradeEntry.builder()
                .entryTime(entry != null ? entry.openTime() : null)
                .exitTime(exit.openTime())
                .entryPrice(entryPrice.setScale(2, RoundingMode.HALF_UP))
                .exitPrice(exitPrice.setScale(2, RoundingMode.HALF_UP))
                .quantity(qty)
                .pnl(pnl)
                .pnlPct(Math.round(pnlPct * 100.0) / 100.0)
                .runningCapital(running)
                .exitReason(exitReason)
                .direction(direction.name())
                .entryPatterns(entryPatterns != null ? entryPatterns : List.of())
                .regime(regime)
                .selectedStrategy(selectedStrategy)
                .scoreBreakdown(scoreBreakdown)
                .build();
    }

    // ─── SL / TP price computation ────────────────────────────────────────────

    private BigDecimal computeSl(BigDecimal entryPrice, PositionDirection dir, BigDecimal slFrac) {
        if (slFrac == null) return null;
        if (dir == PositionDirection.LONG) {
            return entryPrice.multiply(BigDecimal.ONE.subtract(slFrac)).setScale(2, RoundingMode.HALF_UP);
        } else { // SHORT: SL above entry
            return entryPrice.multiply(BigDecimal.ONE.add(slFrac)).setScale(2, RoundingMode.HALF_UP);
        }
    }

    private BigDecimal computeTp(BigDecimal entryPrice, PositionDirection dir, BigDecimal tpFrac) {
        if (tpFrac == null) return null;
        if (dir == PositionDirection.LONG) {
            return entryPrice.multiply(BigDecimal.ONE.add(tpFrac)).setScale(2, RoundingMode.HALF_UP);
        } else { // SHORT: TP below entry
            return entryPrice.multiply(BigDecimal.ONE.subtract(tpFrac)).setScale(2, RoundingMode.HALF_UP);
        }
    }

    /** Converts a percentage BigDecimal (e.g. 2.0) to a fraction (0.02). Returns null if 0 or null. */
    private static BigDecimal fracOrNull(BigDecimal pct) {
        if (pct == null || pct.compareTo(BigDecimal.ZERO) <= 0) return null;
        return pct.divide(BigDecimal.valueOf(100), 8, RoundingMode.HALF_UP);
    }

    /** Apply risk-per-trade position sizing. Falls back to resolvedQty if parameters are absent. */
    private static int sizeQty(int resolvedQty, BigDecimal capital, BigDecimal price,
                                BigDecimal riskFrac, BigDecimal slFrac) {
        if (riskFrac == null || slFrac == null) return resolvedQty;
        BigDecimal riskAmount  = capital.multiply(riskFrac);
        BigDecimal riskPerUnit = price.multiply(slFrac);
        if (riskPerUnit.compareTo(BigDecimal.ZERO) <= 0) return resolvedQty;
        int sized = riskAmount.divide(riskPerUnit, 0, RoundingMode.FLOOR).intValue();
        return Math.max(1, Math.min(sized, resolvedQty));
    }

    // ─── Trade builder ─────────────────────────────────────────────────────────

    private TradeEntry buildTrade(CandleDto entry, CandleDto exit,
                                  BigDecimal entryPrice, BigDecimal exitPrice,
                                  int qty, BigDecimal capitalBefore, String exitReason,
                                  PositionDirection direction,
                                  List<String> entryPatterns, String regime) {
        // Long PnL = (exit − entry) × qty; Short PnL = (entry − exit) × qty
        BigDecimal pnl;
        if (direction == PositionDirection.SHORT) {
            pnl = entryPrice.subtract(exitPrice)
                    .multiply(BigDecimal.valueOf(qty))
                    .setScale(2, RoundingMode.HALF_UP);
        } else {
            pnl = exitPrice.subtract(entryPrice)
                    .multiply(BigDecimal.valueOf(qty))
                    .setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal notional = entryPrice.multiply(BigDecimal.valueOf(qty));
        double pnlPct = notional.compareTo(BigDecimal.ZERO) == 0 ? 0.0
                : pnl.divide(notional, 6, RoundingMode.HALF_UP).doubleValue() * 100.0;
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
                .direction(direction.name())
                .entryPatterns(entryPatterns != null ? entryPatterns : List.of())
                .regime(regime)
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
        if ("CANDLE_PATTERN".equals(strategyType)) {
            String pattern = params != null
                    ? params.getOrDefault("pattern", "HAMMER").toUpperCase().trim()
                    : "HAMMER";
            return switch (pattern) {
                case "MORNING_STAR", "EVENING_STAR"                    -> 3;
                case "BULLISH_ENGULFING", "BEARISH_ENGULFING",
                     "DOJI_REVERSAL"                                    -> 2;
                default                                                 -> 1;
            };
        }
        return 0;
    }

    // ─── Data fetch ───────────────────────────────────────────────────────────

    private List<CandleDto> fetchCandles(BacktestRequest req) {
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
                false
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
