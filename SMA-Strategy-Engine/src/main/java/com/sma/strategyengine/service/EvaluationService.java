package com.sma.strategyengine.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.client.ExecutionEngineClient;
import com.sma.strategyengine.client.ExecutionEngineClient.ExecutionEngineException;
import com.sma.strategyengine.client.ExecutionEngineClient.IntentResponse;
import com.sma.strategyengine.client.ExecutionEngineClient.PlaceIntentPayload;
import com.sma.strategyengine.entity.SignalRecord;
import com.sma.strategyengine.entity.SignalRecord.ExecutionStatus;
import com.sma.strategyengine.entity.StrategyInstance;
import com.sma.strategyengine.entity.StrategyInstance.Status;
import com.sma.strategyengine.model.request.EvaluateRequest;
import com.sma.strategyengine.model.response.EvaluationResponse;
import com.sma.strategyengine.model.response.EvaluationResponse.SignalSummary;
import com.sma.strategyengine.repository.SignalRecordRepository;
import com.sma.strategyengine.repository.StrategyInstanceRepository;
import com.sma.strategyengine.strategy.PositionDirection;
import com.sma.strategyengine.strategy.StrategyContext;
import com.sma.strategyengine.strategy.StrategyRegistry;
import com.sma.strategyengine.strategy.StrategyResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Core evaluation pipeline.
 *
 * For each incoming candle:
 * 1. Find all ACTIVE strategy instances subscribed to that symbol + exchange.
 * 2. Build a {@link StrategyContext} and call the appropriate {@link com.sma.strategyengine.strategy.StrategyLogic}.
 * 3. Determine the order action based on the signal, current position direction, and allowShorting flag.
 * 4. Persist the signal to signal_record.
 * 5. For actionable signals: forward an order intent to Execution Engine.
 *    Strategy Engine NEVER calls Broker Engine directly.
 *
 * <h3>Long/Short logic</h3>
 * <pre>
 * allowShorting = false (long-only):
 *   BUY  + FLAT  → enter long  (BUY  1x)  → LONG
 *   BUY  + LONG  → already long, skip
 *   SELL + LONG  → exit long   (SELL 1x)  → FLAT
 *   SELL + FLAT  → no position to exit, skip
 *
 * allowShorting = true (long-short):
 *   BUY  + FLAT  → enter long  (BUY  1x)  → LONG
 *   BUY  + LONG  → already long, skip
 *   BUY  + SHORT → reverse to long (BUY 2x: cover + enter) → LONG
 *   SELL + FLAT  → enter short (SELL 1x)  → SHORT
 *   SELL + SHORT → already short, skip
 *   SELL + LONG  → reverse to short (SELL 2x: exit + enter) → SHORT
 * </pre>
 *
 * Position direction is tracked in-memory per instance and reset on deactivate/delete.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class EvaluationService {

    private final StrategyInstanceRepository instanceRepository;
    private final SignalRecordRepository     signalRepository;
    private final StrategyRegistry           registry;
    private final StrategyService            strategyService;
    private final ExecutionEngineClient      executionEngineClient;
    private final PositionTracker            positionTracker;
    private final ObjectMapper               objectMapper;

    // ─── Public API ───────────────────────────────────────────────────────────

    @Transactional
    public EvaluationResponse evaluate(EvaluateRequest req) {
        String symbol   = req.getSymbol().toUpperCase();
        String exchange = req.getExchange().toUpperCase();

        List<StrategyInstance> activeInstances =
                instanceRepository.findBySymbolAndExchangeAndStatus(symbol, exchange, Status.ACTIVE);

        if (activeInstances.isEmpty()) {
            log.debug("No active strategy instances for symbol={}, exchange={}", symbol, exchange);
            return EvaluationResponse.builder()
                    .symbol(symbol)
                    .exchange(exchange)
                    .evaluatedInstances(0)
                    .actionableSignals(0)
                    .signals(List.of())
                    .build();
        }

        log.info("Evaluating {} active instance(s) for symbol={}, exchange={}, close={}",
                activeInstances.size(), symbol, exchange, req.getCandle().getClose());

        List<SignalSummary> summaries = new ArrayList<>();
        int actionable = 0;

        for (StrategyInstance instance : activeInstances) {
            SignalSummary summary = evaluateInstance(instance, req);
            summaries.add(summary);
            if (!"HOLD".equals(summary.getSignal())) actionable++;
        }

        return EvaluationResponse.builder()
                .symbol(symbol)
                .exchange(exchange)
                .evaluatedInstances(activeInstances.size())
                .actionableSignals(actionable)
                .signals(summaries)
                .build();
    }


    // ─── Per-instance evaluation ───────────────────────────────────────────────

    private SignalSummary evaluateInstance(StrategyInstance instance, EvaluateRequest req) {
        EvaluateRequest.CandleDto candle = req.getCandle();
        Map<String, String> params = strategyService.parseParams(instance.getParameters());

        String instanceId = instance.getInstanceId();
        PositionDirection currentDir = positionTracker.getDirection(instanceId);

        StrategyContext ctx = StrategyContext.builder()
                .instanceId(instanceId)
                .strategyType(instance.getStrategyType())
                .userId(instance.getUserId())
                .brokerName(instance.getBrokerName())
                .symbol(instance.getSymbol())
                .exchange(instance.getExchange())
                .product(instance.getProduct())
                .quantity(instance.getQuantity())
                .orderType(instance.getOrderType())
                .currentDirection(currentDir)
                .allowShorting(instance.isAllowShorting())
                .candleOpenTime(candle.getOpenTime())
                .candleOpen(candle.getOpen())
                .candleHigh(candle.getHigh())
                .candleLow(candle.getLow())
                .candleClose(candle.getClose())
                .candleVolume(candle.getVolume())
                .params(params)
                .build();

        StrategyResult result;
        try {
            result = registry.resolve(instance.getStrategyType()).evaluate(ctx);
        } catch (Exception e) {
            log.error("Strategy evaluation error: instanceId={}, error={}", instanceId, e.getMessage(), e);
            markInstanceError(instance, e.getMessage());
            return SignalSummary.builder()
                    .instanceId(instanceId)
                    .instanceName(instance.getName())
                    .strategyType(instance.getStrategyType())
                    .signal("HOLD")
                    .reason("Evaluation error: " + e.getMessage())
                    .executionStatus("SKIPPED")
                    .build();
        }

        // Determine the order action for this signal + current direction
        String intentId = null;
        ExecutionStatus execStatus = ExecutionStatus.SKIPPED;

        if (result.isActionable()) {
            OrderAction action = resolveOrderAction(result.isBuy(), currentDir, instance.isAllowShorting());

            if (action != null) {
                intentId   = generateIntentId();
                execStatus = sendToExecutionEngine(instance, action.side(), action.quantityMultiplier(), intentId);
                if (execStatus == ExecutionStatus.SENT) {
                    positionTracker.setDirection(instanceId, action.newDirection());
                    log.info("Position updated: instanceId={}, {} → {}", instanceId, currentDir, action.newDirection());
                } else {
                    intentId = null; // don't persist a meaningless ID
                }
            } else {
                log.debug("Signal {} skipped — already in desired direction or shorting not allowed: instanceId={}, dir={}",
                        result.getSignal(), instanceId, currentDir);
            }
        }

        persistSignal(instance, result, candle, intentId, execStatus);

        return SignalSummary.builder()
                .instanceId(instanceId)
                .instanceName(instance.getName())
                .strategyType(instance.getStrategyType())
                .signal(result.getSignal().name())
                .reason(result.getReason())
                .intentId(intentId)
                .executionStatus(execStatus.name())
                .build();
    }

    // ─── Order action resolution ──────────────────────────────────────────────

    /**
     * Resolves what order to place (or null if no order needed) based on the signal,
     * current direction, and whether shorting is allowed.
     *
     * @param isBuy       true = BUY signal, false = SELL signal
     * @param currentDir  current position direction
     * @param allowShort  whether this instance permits short positions
     * @return OrderAction (side, quantity multiplier, resulting direction), or null to skip
     */
    private OrderAction resolveOrderAction(boolean isBuy, PositionDirection currentDir, boolean allowShort) {
        if (isBuy) {
            return switch (currentDir) {
                case FLAT  -> new OrderAction("BUY", 1, PositionDirection.LONG);
                case LONG  -> null; // already long
                case SHORT -> allowShort
                        ? new OrderAction("BUY", 2, PositionDirection.LONG)   // cover + enter long
                        : new OrderAction("BUY", 1, PositionDirection.FLAT);  // cover only (shouldn't be SHORT if !allowShort)
            };
        } else {
            // SELL signal
            return switch (currentDir) {
                case FLAT  -> allowShort
                        ? new OrderAction("SELL", 1, PositionDirection.SHORT)  // enter short
                        : null;                                                  // no position to exit, skip
                case LONG  -> allowShort
                        ? new OrderAction("SELL", 2, PositionDirection.SHORT)  // exit long + enter short
                        : new OrderAction("SELL", 1, PositionDirection.FLAT);  // exit long only
                case SHORT -> null; // already short
            };
        }
    }

    /** Immutable order instruction produced by {@link #resolveOrderAction}. */
    private record OrderAction(String side, int quantityMultiplier, PositionDirection newDirection) {}

    // ─── Execution Engine dispatch ────────────────────────────────────────────

    private ExecutionStatus sendToExecutionEngine(
            StrategyInstance instance,
            String           side,
            int              quantityMultiplier,
            String           intentId) {
        try {
            int effectiveQty = instance.getQuantity() * quantityMultiplier;

            PlaceIntentPayload payload = new PlaceIntentPayload(
                    intentId,
                    instance.getUserId(),
                    instance.getBrokerName(),
                    instance.getSymbol(),
                    instance.getExchange(),
                    side,
                    instance.getOrderType(),
                    instance.getProduct(),
                    effectiveQty,
                    null,   // price — null for MARKET orders
                    null,   // triggerPrice
                    "DAY",
                    "strategy-" + instance.getStrategyType().toLowerCase()
            );

            IntentResponse response = executionEngineClient.placeIntent(payload);

            if (response.success()) {
                log.info("Intent accepted by Execution Engine: intentId={}, instanceId={}, side={}, qty={}, symbol={}",
                        intentId, instance.getInstanceId(), side, effectiveQty, instance.getSymbol());
                return ExecutionStatus.SENT;
            } else {
                log.warn("Execution Engine rejected intent: intentId={}, message={}", intentId, response.message());
                return ExecutionStatus.FAILED;
            }

        } catch (ExecutionEngineException e) {
            log.error("Failed to send intent to Execution Engine: intentId={}, error={}", intentId, e.getMessage(), e);
            return ExecutionStatus.FAILED;
        }
    }

    // ─── Persistence ──────────────────────────────────────────────────────────

    private void persistSignal(
            StrategyInstance          instance,
            StrategyResult            result,
            EvaluateRequest.CandleDto candle,
            String                    intentId,
            ExecutionStatus           execStatus) {
        SignalRecord.Signal signalEnum = switch (result.getSignal()) {
            case BUY  -> SignalRecord.Signal.BUY;
            case SELL -> SignalRecord.Signal.SELL;
            case HOLD -> SignalRecord.Signal.HOLD;
        };

        String metaJson = serializeMeta(result.getMeta());

        SignalRecord record = SignalRecord.builder()
                .signalId(UUID.randomUUID().toString())
                .instanceId(instance.getInstanceId())
                .strategyType(instance.getStrategyType())
                .symbol(instance.getSymbol())
                .exchange(instance.getExchange())
                .signal(signalEnum)
                .candleClose(candle.getClose())
                .intentId(intentId)
                .executionStatus(execStatus)
                .meta(metaJson)
                .build();

        signalRepository.save(record);
    }

    private void markInstanceError(StrategyInstance instance, String errorMsg) {
        instance.setStatus(Status.ERROR);
        instanceRepository.save(instance);
        log.warn("Marked strategy instance as ERROR: instanceId={}, reason={}", instance.getInstanceId(), errorMsg);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private String generateIntentId() {
        return "SE-" + UUID.randomUUID().toString().replace("-", "").substring(0, 16).toUpperCase();
    }

    private String serializeMeta(Map<String, Object> meta) {
        if (meta == null || meta.isEmpty()) return null;
        try {
            return objectMapper.writeValueAsString(meta);
        } catch (Exception e) {
            return null;
        }
    }
}
