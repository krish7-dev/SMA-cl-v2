package com.sma.strategyengine.model.response;

import com.sma.strategyengine.entity.StrategyInstance;
import lombok.Builder;
import lombok.Value;

import java.time.Instant;
import java.util.Map;

@Value
@Builder
public class StrategyResponse {

    String              instanceId;
    String              name;
    String              strategyType;
    String              userId;
    String              brokerName;
    String              symbol;
    String              exchange;
    String              product;
    int                 quantity;
    String              orderType;
    boolean             allowShorting;
    Map<String, String> parameters;
    String              status;
    Instant             createdAt;
    Instant             updatedAt;

    public static StrategyResponse from(StrategyInstance entity, Map<String, String> parsedParams) {
        return StrategyResponse.builder()
                .instanceId(entity.getInstanceId())
                .name(entity.getName())
                .strategyType(entity.getStrategyType())
                .userId(entity.getUserId())
                .brokerName(entity.getBrokerName())
                .symbol(entity.getSymbol())
                .exchange(entity.getExchange())
                .product(entity.getProduct())
                .quantity(entity.getQuantity())
                .orderType(entity.getOrderType())
                .allowShorting(entity.isAllowShorting())
                .parameters(parsedParams)
                .status(entity.getStatus().name())
                .createdAt(entity.getCreatedAt())
                .updatedAt(entity.getUpdatedAt())
                .build();
    }
}
