package com.sma.strategyengine.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.entity.StrategyInstance;
import com.sma.strategyengine.entity.StrategyInstance.Status;
import com.sma.strategyengine.model.request.CreateStrategyRequest;
import com.sma.strategyengine.model.request.UpdateStrategyRequest;
import com.sma.strategyengine.model.response.StrategyResponse;
import com.sma.strategyengine.repository.StrategyInstanceRepository;
import com.sma.strategyengine.strategy.StrategyRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * CRUD and lifecycle management for strategy instances.
 *
 * Lifecycle transitions:
 *   create   → INACTIVE
 *   activate → ACTIVE   (starts receiving candle evaluations)
 *   deactivate → INACTIVE
 *   delete   → removed from DB + in-memory state cleared
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class StrategyService {

    private final StrategyInstanceRepository repository;
    private final StrategyRegistry           registry;
    private final PositionTracker            positionTracker;
    private final ObjectMapper               objectMapper;

    private static final TypeReference<Map<String, String>> PARAM_TYPE = new TypeReference<>() {};

    // ─── Create ───────────────────────────────────────────────────────────────

    @Transactional
    public StrategyResponse create(CreateStrategyRequest req) {
        if (!registry.isKnownType(req.getStrategyType())) {
            throw new IllegalArgumentException("Unknown strategy type: '" + req.getStrategyType() +
                    "'. Available: " + registry.availableTypes());
        }

        StrategyInstance instance = StrategyInstance.builder()
                .instanceId(UUID.randomUUID().toString())
                .name(req.getName())
                .strategyType(req.getStrategyType())
                .userId(req.getUserId())
                .brokerName(req.getBrokerName())
                .symbol(req.getSymbol().toUpperCase())
                .exchange(req.getExchange().toUpperCase())
                .product(req.getProduct().toUpperCase())
                .quantity(req.getQuantity())
                .orderType(req.getOrderType() != null ? req.getOrderType().toUpperCase() : "MARKET")
                .allowShorting(req.isAllowShorting())
                .parameters(serializeParams(req.getParameters()))
                .status(Status.INACTIVE)
                .build();

        repository.save(instance);
        log.info("Strategy instance created: instanceId={}, type={}, symbol={}",
                instance.getInstanceId(), instance.getStrategyType(), instance.getSymbol());

        return toResponse(instance);
    }

    // ─── Read ─────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public StrategyResponse getById(String instanceId) {
        return toResponse(findOrThrow(instanceId));
    }

    @Transactional(readOnly = true)
    public List<StrategyResponse> listByUser(String userId, String status) {
        List<StrategyInstance> records = (status != null && !status.isBlank())
                ? repository.findByUserIdAndStatusOrderByCreatedAtDesc(userId, Status.valueOf(status.toUpperCase()))
                : repository.findByUserIdOrderByCreatedAtDesc(userId);
        return records.stream().map(this::toResponse).toList();
    }

    // ─── Update ───────────────────────────────────────────────────────────────

    @Transactional
    public StrategyResponse update(String instanceId, UpdateStrategyRequest req) {
        StrategyInstance instance = findOrThrow(instanceId);

        if (req.getName()          != null) instance.setName(req.getName());
        if (req.getQuantity()      != null) instance.setQuantity(req.getQuantity());
        if (req.getProduct()       != null) instance.setProduct(req.getProduct().toUpperCase());
        if (req.getOrderType()     != null) instance.setOrderType(req.getOrderType().toUpperCase());
        if (req.getAllowShorting()  != null) instance.setAllowShorting(req.getAllowShorting());
        if (req.getParameters()    != null) instance.setParameters(serializeParams(req.getParameters()));

        repository.save(instance);
        log.info("Strategy instance updated: instanceId={}", instanceId);
        return toResponse(instance);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    @Transactional
    public StrategyResponse activate(String instanceId) {
        StrategyInstance instance = findOrThrow(instanceId);
        if (instance.getStatus() == Status.ACTIVE) {
            throw new IllegalStateException("Strategy instance is already ACTIVE: " + instanceId);
        }
        instance.setStatus(Status.ACTIVE);
        repository.save(instance);
        log.info("Strategy instance activated: instanceId={}", instanceId);
        return toResponse(instance);
    }

    @Transactional
    public StrategyResponse deactivate(String instanceId) {
        StrategyInstance instance = findOrThrow(instanceId);
        if (instance.getStatus() == Status.INACTIVE) {
            throw new IllegalStateException("Strategy instance is already INACTIVE: " + instanceId);
        }
        instance.setStatus(Status.INACTIVE);
        repository.save(instance);
        positionTracker.reset(instanceId);
        log.info("Strategy instance deactivated: instanceId={}", instanceId);
        return toResponse(instance);
    }

    // ─── Delete ───────────────────────────────────────────────────────────────

    @Transactional
    public void delete(String instanceId) {
        StrategyInstance instance = findOrThrow(instanceId);
        repository.delete(instance);
        // Release in-memory state (price windows + position direction)
        registry.resolve(instance.getStrategyType()).onInstanceRemoved(instanceId);
        positionTracker.reset(instanceId);
        log.info("Strategy instance deleted: instanceId={}", instanceId);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    StrategyInstance findOrThrow(String instanceId) {
        return repository.findByInstanceId(instanceId)
                .orElseThrow(() -> new IllegalArgumentException("Strategy instance not found: " + instanceId));
    }

    StrategyResponse toResponse(StrategyInstance instance) {
        return StrategyResponse.from(instance, parseParams(instance.getParameters()));
    }

    private String serializeParams(Map<String, String> params) {
        if (params == null || params.isEmpty()) return "{}";
        try {
            return objectMapper.writeValueAsString(params);
        } catch (Exception e) {
            throw new IllegalArgumentException("Failed to serialize parameters: " + e.getMessage(), e);
        }
    }

    Map<String, String> parseParams(String json) {
        if (json == null || json.isBlank()) return Map.of();
        try {
            return objectMapper.readValue(json, PARAM_TYPE);
        } catch (Exception e) {
            log.warn("Failed to parse parameters JSON: {}", json);
            return Map.of();
        }
    }
}
