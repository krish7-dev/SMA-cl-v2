package com.sma.brokerengine.service;

import com.sma.brokerengine.adapter.BrokerAdapter;
import com.sma.brokerengine.adapter.BrokerAdapterRegistry;
import com.sma.brokerengine.entity.BrokerAccount;
import com.sma.brokerengine.entity.OrderRecord;
import com.sma.brokerengine.model.request.CancelOrderRequest;
import com.sma.brokerengine.model.request.PlaceOrderRequest;
import com.sma.brokerengine.model.response.OrderResponse;
import com.sma.brokerengine.repository.BrokerAccountRepository;
import com.sma.brokerengine.repository.OrderRecordRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRecordRepository orderRecordRepository;
    private final BrokerAccountRepository brokerAccountRepository;
    private final BrokerAdapterRegistry adapterRegistry;
    private final BrokerAuthService authService;

    /**
     * Places an order with the broker.
     *
     * Idempotent: if an order with the same clientOrderId already exists,
     * the existing record is returned without placing a duplicate order.
     */
    @Transactional
    public OrderResponse placeOrder(PlaceOrderRequest request) {
        // Idempotency check
        if (orderRecordRepository.existsByClientOrderId(request.getClientOrderId())) {
            log.warn("Duplicate order submission detected: clientOrderId={}", request.getClientOrderId());
            return orderRecordRepository.findByClientOrderId(request.getClientOrderId())
                    .map(OrderResponse::from)
                    .orElseThrow();
        }

        BrokerAccount account = resolveBrokerAccount(request.getUserId(), request.getBrokerName());
        BrokerAdapter adapter = adapterRegistry.resolve(request.getBrokerName());

        String accessToken = authService.resolveAccessToken(request.getUserId(), request.getBrokerName());
        String apiKey = authService.resolveApiKey(request.getUserId(), request.getBrokerName());

        // Persist order in PENDING state before hitting broker
        OrderRecord record = OrderRecord.builder()
                .clientOrderId(request.getClientOrderId())
                .brokerAccount(account)
                .symbol(request.getSymbol())
                .exchange(request.getExchange())
                .transactionType(request.getTransactionType())
                .orderType(request.getOrderType())
                .product(request.getProduct())
                .quantity(request.getQuantity())
                .price(request.getPrice())
                .triggerPrice(request.getTriggerPrice())
                .validity(request.getValidity())
                .tag(request.getTag())
                .status(OrderRecord.OrderStatus.PENDING)
                .build();

        record = orderRecordRepository.save(record);

        try {
            Map<String, Object> params = buildOrderParams(request);
            String brokerOrderId = adapter.placeOrder(accessToken, apiKey, params);

            record.setBrokerOrderId(brokerOrderId);
            record.setStatus(OrderRecord.OrderStatus.OPEN);
            record.setPlacedAt(Instant.now());
            log.info("Order placed: clientOrderId={}, brokerOrderId={}", request.getClientOrderId(), brokerOrderId);
        } catch (Exception e) {
            record.setStatus(OrderRecord.OrderStatus.REJECTED);
            record.setStatusMessage(e.getMessage());
            log.error("Order placement failed: clientOrderId={}, error={}", request.getClientOrderId(), e.getMessage());
        }

        record = orderRecordRepository.save(record);
        return OrderResponse.from(record);
    }

    /**
     * Cancels an open order by clientOrderId.
     */
    @Transactional
    public OrderResponse cancelOrder(CancelOrderRequest request) {
        OrderRecord record = orderRecordRepository.findByClientOrderId(request.getClientOrderId())
                .orElseThrow(() -> new OrderNotFoundException("Order not found: " + request.getClientOrderId()));

        if (record.getBrokerOrderId() == null) {
            throw new OrderCancellationException("Order has no broker order ID — cannot cancel");
        }

        BrokerAdapter adapter = adapterRegistry.resolve(request.getBrokerName());
        String accessToken = authService.resolveAccessToken(request.getUserId(), request.getBrokerName());
        String apiKey = authService.resolveApiKey(request.getUserId(), request.getBrokerName());

        try {
            adapter.cancelOrder(accessToken, apiKey, record.getBrokerOrderId(), "regular");
            record.setStatus(OrderRecord.OrderStatus.CANCELLED);
            log.info("Order cancelled: clientOrderId={}, brokerOrderId={}", record.getClientOrderId(), record.getBrokerOrderId());
        } catch (Exception e) {
            record.setStatusMessage("Cancel failed: " + e.getMessage());
            log.error("Order cancellation failed: clientOrderId={}, error={}", record.getClientOrderId(), e.getMessage());
            throw new OrderCancellationException("Failed to cancel order: " + e.getMessage());
        }

        record = orderRecordRepository.save(record);
        return OrderResponse.from(record);
    }

    /**
     * Returns the latest status of an order from the platform DB.
     */
    @Transactional(readOnly = true)
    public OrderResponse getOrder(String clientOrderId) {
        return orderRecordRepository.findByClientOrderId(clientOrderId)
                .map(OrderResponse::from)
                .orElseThrow(() -> new OrderNotFoundException("Order not found: " + clientOrderId));
    }

    /**
     * Returns all orders for a broker account.
     */
    @Transactional(readOnly = true)
    public List<OrderResponse> getOrdersForAccount(String userId, String brokerName) {
        BrokerAccount account = resolveBrokerAccount(userId, brokerName);
        return orderRecordRepository.findAllByBrokerAccountId(account.getId())
                .stream()
                .map(OrderResponse::from)
                .collect(Collectors.toList());
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    private BrokerAccount resolveBrokerAccount(String userId, String brokerName) {
        return brokerAccountRepository.findByUserIdAndBrokerName(userId, brokerName)
                .orElseThrow(() -> new BrokerAuthService.AccountNotFoundException(
                        "No broker account found for userId=" + userId + ", broker=" + brokerName));
    }

    private Map<String, Object> buildOrderParams(PlaceOrderRequest request) {
        Map<String, Object> params = new HashMap<>();
        params.put("symbol", request.getSymbol());
        params.put("exchange", request.getExchange());
        params.put("transactionType", request.getTransactionType().name());
        params.put("orderType", request.getOrderType().name());
        params.put("product", request.getProduct().name());
        params.put("quantity", request.getQuantity());
        params.put("price", request.getPrice());
        params.put("triggerPrice", request.getTriggerPrice());
        params.put("validity", request.getValidity() != null ? request.getValidity() : "DAY");
        params.put("tag", request.getTag());
        return params;
    }

    public static class OrderNotFoundException extends RuntimeException {
        public OrderNotFoundException(String message) { super(message); }
    }

    public static class OrderCancellationException extends RuntimeException {
        public OrderCancellationException(String message) { super(message); }
    }
}
