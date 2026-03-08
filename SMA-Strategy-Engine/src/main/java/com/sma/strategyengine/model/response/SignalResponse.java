package com.sma.strategyengine.model.response;

import com.sma.strategyengine.entity.SignalRecord;
import lombok.Builder;
import lombok.Value;

import java.math.BigDecimal;
import java.time.Instant;

@Value
@Builder
public class SignalResponse {

    String     signalId;
    String     instanceId;
    String     strategyType;
    String     symbol;
    String     exchange;
    String     signal;
    BigDecimal candleClose;
    String     intentId;
    String     executionStatus;
    String     meta;
    Instant    createdAt;

    public static SignalResponse from(SignalRecord entity) {
        return SignalResponse.builder()
                .signalId(entity.getSignalId())
                .instanceId(entity.getInstanceId())
                .strategyType(entity.getStrategyType())
                .symbol(entity.getSymbol())
                .exchange(entity.getExchange())
                .signal(entity.getSignal().name())
                .candleClose(entity.getCandleClose())
                .intentId(entity.getIntentId())
                .executionStatus(entity.getExecutionStatus().name())
                .meta(entity.getMeta())
                .createdAt(entity.getCreatedAt())
                .build();
    }
}
