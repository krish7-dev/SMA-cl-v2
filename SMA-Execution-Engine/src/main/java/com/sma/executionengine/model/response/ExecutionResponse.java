package com.sma.executionengine.model.response;

import com.sma.executionengine.entity.ExecutionRecord;
import lombok.Builder;
import lombok.Data;

import java.math.BigDecimal;
import java.time.Instant;

@Data
@Builder
public class ExecutionResponse {

    private Long   id;
    private String intentId;
    private String brokerClientOrderId;
    private String brokerOrderId;
    private String userId;
    private String brokerName;
    private String symbol;
    private String exchange;
    private ExecutionRecord.Side      side;
    private ExecutionRecord.OrderType orderType;
    private ExecutionRecord.Product   product;
    private Integer    quantity;
    private BigDecimal price;
    private BigDecimal triggerPrice;
    private String     validity;
    private String     tag;
    private ExecutionRecord.Status status;
    private String     errorMessage;
    private Instant    createdAt;
    private Instant    updatedAt;

    public static ExecutionResponse from(ExecutionRecord r) {
        return ExecutionResponse.builder()
                .id(r.getId())
                .intentId(r.getIntentId())
                .brokerClientOrderId(r.getBrokerClientOrderId())
                .brokerOrderId(r.getBrokerOrderId())
                .userId(r.getUserId())
                .brokerName(r.getBrokerName())
                .symbol(r.getSymbol())
                .exchange(r.getExchange())
                .side(r.getSide())
                .orderType(r.getOrderType())
                .product(r.getProduct())
                .quantity(r.getQuantity())
                .price(r.getPrice())
                .triggerPrice(r.getTriggerPrice())
                .validity(r.getValidity())
                .tag(r.getTag())
                .status(r.getStatus())
                .errorMessage(r.getErrorMessage())
                .createdAt(r.getCreatedAt())
                .updatedAt(r.getUpdatedAt())
                .build();
    }
}
