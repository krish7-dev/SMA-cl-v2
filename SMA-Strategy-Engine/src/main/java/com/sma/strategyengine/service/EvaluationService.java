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
 * 3. Persist the signal to signal_record.
 * 4. For BUY/SELL signals: forward an order intent to Execution Engine.
 *    Strategy Engine NEVER calls Broker Engine directly.
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

        StrategyContext ctx = StrategyContext.builder()
                .instanceId(instance.getInstanceId())
                .strategyType(instance.getStrategyType())
                .userId(instance.getUserId())
                .brokerName(instance.getBrokerName())
                .symbol(instance.getSymbol())
                .exchange(instance.getExchange())
                .product(instance.getProduct())
                .quantity(instance.getQuantity())
                .orderType(instance.getOrderType())
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
            log.error("Strategy evaluation error: instanceId={}, error={}", instance.getInstanceId(), e.getMessage(), e);
            markInstanceError(instance, e.getMessage());
            return SignalSummary.builder()
                    .instanceId(instance.getInstanceId())
                    .instanceName(instance.getName())
                    .strategyType(instance.getStrategyType())
                    .signal("HOLD")
                    .reason("Evaluation error: " + e.getMessage())
                    .executionStatus("SKIPPED")
                    .build();
        }

        // Dispatch actionable signals to Execution Engine
        String intentId = null;
        ExecutionStatus execStatus = ExecutionStatus.SKIPPED;

        if (result.isActionable()) {
            intentId   = generateIntentId();
            execStatus = sendToExecutionEngine(instance, result, intentId, candle.getClose().doubleValue());
            if (execStatus == ExecutionStatus.FAILED) {
                intentId = null; // don't persist a meaningless ID
            }
        }

        // Persist signal audit record
        persistSignal(instance, result, candle, intentId, execStatus);

        return SignalSummary.builder()
                .instanceId(instance.getInstanceId())
                .instanceName(instance.getName())
                .strategyType(instance.getStrategyType())
                .signal(result.getSignal().name())
                .reason(result.getReason())
                .intentId(intentId)
                .executionStatus(execStatus.name())
                .build();
    }

    // ─── Execution Engine dispatch ────────────────────────────────────────────

    private ExecutionStatus sendToExecutionEngine(
            StrategyInstance instance,
            StrategyResult   result,
            String           intentId,
            double           closePrice) {
        try {
            String side = result.isBuy() ? "BUY" : "SELL";

            PlaceIntentPayload payload = new PlaceIntentPayload(
                    intentId,
                    instance.getUserId(),
                    instance.getBrokerName(),
                    instance.getSymbol(),
                    instance.getExchange(),
                    side,
                    instance.getOrderType(),
                    instance.getProduct(),
                    instance.getQuantity(),
                    null,   // price — null for MARKET orders
                    null,   // triggerPrice
                    "DAY",
                    "strategy-" + instance.getStrategyType().toLowerCase()
            );

            IntentResponse response = executionEngineClient.placeIntent(payload);

            if (response.success()) {
                log.info("Intent accepted by Execution Engine: intentId={}, instanceId={}, side={}, symbol={}",
                        intentId, instance.getInstanceId(), side, instance.getSymbol());
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
            StrategyInstance   instance,
            StrategyResult     result,
            EvaluateRequest.CandleDto candle,
            String             intentId,
            ExecutionStatus    execStatus) {
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
