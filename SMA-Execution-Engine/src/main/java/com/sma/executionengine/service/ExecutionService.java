package com.sma.executionengine.service;

import com.sma.executionengine.client.BrokerEngineClient;
import com.sma.executionengine.client.BrokerEngineClient.BrokerEngineException;
import com.sma.executionengine.client.BrokerEngineClient.BrokerOrderResponse;
import com.sma.executionengine.client.BrokerEngineClient.CancelOrderPayload;
import com.sma.executionengine.client.BrokerEngineClient.PlaceOrderPayload;
import com.sma.executionengine.entity.ExecutionRecord;
import com.sma.executionengine.entity.ExecutionRecord.Status;
import com.sma.executionengine.model.request.ExecutionRequest;
import com.sma.executionengine.model.response.ExecutionResponse;
import com.sma.executionengine.repository.ExecutionRepository;
import com.sma.executionengine.service.RiskCheckService.RiskViolationException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Core execution orchestrator.
 *
 * Submit flow:
 * 1. Idempotency check - return existing record if intentId already seen.
 * 2. Persist with PENDING status.
 * 3. Run risk checks (RiskCheckService).
 * 4. Build PlaceOrderPayload and call Broker Engine.
 * 5. Update record to SUBMITTED (or FAILED / REJECTED on error).
 * 6. Return ExecutionResponse.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ExecutionService {

    private final ExecutionRepository executionRepository;
    private final RiskCheckService    riskCheckService;
    private final BrokerEngineClient  brokerEngineClient;

    // --- Submit ---------------------------------------------------------------

    @Transactional
    public ExecutionResponse submit(ExecutionRequest request) {
        // Idempotency - return existing record without re-processing
        return executionRepository.findByIntentId(request.getIntentId())
                .map(existing -> {
                    log.info("Duplicate intentId={} - returning existing status={}",
                            request.getIntentId(), existing.getStatus());
                    return ExecutionResponse.from(existing);
                })
                .orElseGet(() -> doSubmit(request));
    }

    private ExecutionResponse doSubmit(ExecutionRequest request) {
        String brokerClientOrderId = "EX-" + UUID.randomUUID().toString().replace("-", "").substring(0, 16).toUpperCase();

        ExecutionRecord record = ExecutionRecord.builder()
                .intentId(request.getIntentId())
                .brokerClientOrderId(brokerClientOrderId)
                .userId(request.getUserId())
                .brokerName(request.getBrokerName())
                .symbol(request.getSymbol())
                .exchange(request.getExchange())
                .side(request.getSide())
                .orderType(request.getOrderType())
                .product(request.getProduct())
                .quantity(request.getQuantity())
                .price(request.getPrice())
                .triggerPrice(request.getTriggerPrice())
                .validity(request.getValidity())
                .tag(request.getTag())
                .status(Status.PENDING)
                .build();

        executionRepository.save(record);
        log.info("ExecutionRecord created: intentId={}, brokerClientOrderId={}",
                record.getIntentId(), brokerClientOrderId);

        // Risk checks
        try {
            riskCheckService.validate(request);
        } catch (RiskViolationException e) {
            record.setStatus(Status.FAILED);
            record.setErrorMessage("Risk check failed: " + e.getMessage());
            executionRepository.save(record);
            log.warn("Risk check failed: intentId={}, reason={}", record.getIntentId(), e.getMessage());
            return ExecutionResponse.from(record);
        }

        // Submit to Broker Engine
        try {
            PlaceOrderPayload payload = new PlaceOrderPayload(
                    brokerClientOrderId,
                    request.getUserId(),
                    request.getBrokerName(),
                    request.getSymbol(),
                    request.getExchange(),
                    request.getSide().name(),
                    request.getOrderType().name(),
                    request.getProduct().name(),
                    request.getQuantity(),
                    request.getPrice(),
                    request.getTriggerPrice(),
                    request.getValidity(),
                    request.getTag()
            );

            BrokerOrderResponse response = brokerEngineClient.placeOrder(payload);

            if (response.success() && response.data() != null) {
                record.setBrokerOrderId(response.data().brokerOrderId());
                record.setStatus(Status.SUBMITTED);
                log.info("Order submitted: intentId={}, brokerOrderId={}",
                        record.getIntentId(), response.data().brokerOrderId());
            } else {
                String reason = response.message() != null ? response.message() : "Broker rejected the order";
                record.setStatus(Status.REJECTED);
                record.setErrorMessage(reason);
                log.warn("Order rejected: intentId={}, reason={}", record.getIntentId(), reason);
            }

        } catch (BrokerEngineException e) {
            record.setStatus(Status.FAILED);
            record.setErrorMessage("Broker Engine call failed: " + e.getMessage());
            log.error("Broker Engine call failed: intentId={}, error={}",
                    record.getIntentId(), e.getMessage(), e);
        }

        executionRepository.save(record);
        return ExecutionResponse.from(record);
    }

    // --- Cancel ---------------------------------------------------------------

    @Transactional
    public ExecutionResponse cancel(String intentId) {
        ExecutionRecord record = executionRepository.findByIntentId(intentId)
                .orElseThrow(() -> new IllegalArgumentException("Execution record not found: " + intentId));

        if (record.getStatus() != Status.SUBMITTED) {
            throw new IllegalStateException(
                    "Cannot cancel execution in status " + record.getStatus() +
                    ". Only SUBMITTED orders can be cancelled.");
        }

        try {
            CancelOrderPayload payload = new CancelOrderPayload(
                    record.getBrokerClientOrderId(),
                    record.getUserId(),
                    record.getBrokerName()
            );
            brokerEngineClient.cancelOrder(payload);
            record.setStatus(Status.CANCELLED);
            log.info("Order cancelled: intentId={}", intentId);
        } catch (BrokerEngineException e) {
            record.setStatus(Status.FAILED);
            record.setErrorMessage("Cancel failed: " + e.getMessage());
            log.error("Cancel failed for intentId={}: {}", intentId, e.getMessage(), e);
        }

        executionRepository.save(record);
        return ExecutionResponse.from(record);
    }

    // --- Queries --------------------------------------------------------------

    @Transactional(readOnly = true)
    public ExecutionResponse getByIntentId(String intentId) {
        return executionRepository.findByIntentId(intentId)
                .map(ExecutionResponse::from)
                .orElseThrow(() -> new IllegalArgumentException("Execution record not found: " + intentId));
    }

    @Transactional(readOnly = true)
    public List<ExecutionResponse> getByUser(String userId, String brokerName) {
        List<ExecutionRecord> records = (brokerName != null && !brokerName.isBlank())
                ? executionRepository.findByUserIdAndBrokerNameOrderByCreatedAtDesc(userId, brokerName)
                : executionRepository.findByUserIdOrderByCreatedAtDesc(userId);
        return records.stream().map(ExecutionResponse::from).toList();
    }

    /**
     * Syncs status by querying Broker Engine. Call after submit to detect fills/rejections.
     */
    @Transactional
    public ExecutionResponse syncStatus(String intentId) {
        ExecutionRecord record = executionRepository.findByIntentId(intentId)
                .orElseThrow(() -> new IllegalArgumentException("Execution record not found: " + intentId));

        if (record.getBrokerClientOrderId() == null) {
            return ExecutionResponse.from(record);
        }

        try {
            BrokerOrderResponse response = brokerEngineClient.getOrderStatus(record.getBrokerClientOrderId());
            if (response.success() && response.data() != null) {
                Status mapped = mapBrokerStatus(response.data().status());
                if (mapped != null && mapped != record.getStatus()) {
                    record.setStatus(mapped);
                    log.info("Status synced: intentId={}, newStatus={}", intentId, mapped);
                    executionRepository.save(record);
                }
            }
        } catch (BrokerEngineException e) {
            log.warn("Status sync failed for intentId={}: {}", intentId, e.getMessage());
        }

        return ExecutionResponse.from(record);
    }

    // --- Helpers --------------------------------------------------------------

    private Status mapBrokerStatus(String brokerStatus) {
        if (brokerStatus == null) return null;
        return switch (brokerStatus.toUpperCase()) {
            case "COMPLETE"  -> Status.FILLED;
            case "REJECTED"  -> Status.REJECTED;
            case "CANCELLED" -> Status.CANCELLED;
            default          -> null;
        };
    }
}
