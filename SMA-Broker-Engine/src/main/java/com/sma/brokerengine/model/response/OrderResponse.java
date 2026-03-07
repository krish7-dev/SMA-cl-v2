package com.sma.brokerengine.model.response;

import com.sma.brokerengine.entity.OrderRecord;
import lombok.Builder;
import lombok.Data;

import java.math.BigDecimal;
import java.time.Instant;

@Data
@Builder
public class OrderResponse {

    private Long id;
    private String clientOrderId;
    private String brokerOrderId;
    private String symbol;
    private String exchange;
    private OrderRecord.TransactionType transactionType;
    private OrderRecord.OrderType orderType;
    private OrderRecord.Product product;
    private Integer quantity;
    private BigDecimal price;
    private BigDecimal triggerPrice;
    private OrderRecord.OrderStatus status;
    private String statusMessage;
    private Integer filledQuantity;
    private BigDecimal averagePrice;
    private String validity;
    private String tag;
    private Instant placedAt;
    private Instant updatedAt;

    public static OrderResponse from(OrderRecord record) {
        return OrderResponse.builder()
                .id(record.getId())
                .clientOrderId(record.getClientOrderId())
                .brokerOrderId(record.getBrokerOrderId())
                .symbol(record.getSymbol())
                .exchange(record.getExchange())
                .transactionType(record.getTransactionType())
                .orderType(record.getOrderType())
                .product(record.getProduct())
                .quantity(record.getQuantity())
                .price(record.getPrice())
                .triggerPrice(record.getTriggerPrice())
                .status(record.getStatus())
                .statusMessage(record.getStatusMessage())
                .filledQuantity(record.getFilledQuantity())
                .averagePrice(record.getAveragePrice())
                .validity(record.getValidity())
                .tag(record.getTag())
                .placedAt(record.getPlacedAt())
                .updatedAt(record.getUpdatedAt())
                .build();
    }
}
