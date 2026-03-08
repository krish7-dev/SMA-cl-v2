package com.sma.strategyengine.model.response;

import lombok.Builder;
import lombok.Value;

import java.util.List;

/**
 * Result of a single {@code POST /api/v1/strategy/evaluate} call.
 *
 * Summarises how many active instances were evaluated for the submitted candle
 * and what signals each produced.
 */
@Value
@Builder
public class EvaluationResponse {

    String            symbol;
    String            exchange;
    int               evaluatedInstances;
    int               actionableSignals;
    List<SignalSummary> signals;

    @Value
    @Builder
    public static class SignalSummary {
        String instanceId;
        String instanceName;
        String strategyType;
        String signal;
        String reason;
        String intentId;
        String executionStatus;
    }
}
