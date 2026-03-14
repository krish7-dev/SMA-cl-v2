package com.sma.strategyengine.model.request;

import jakarta.validation.constraints.*;
import lombok.Data;

import java.util.Map;

@Data
public class CreateStrategyRequest {

    @NotBlank(message = "name is required")
    private String name;

    @NotBlank(message = "strategyType is required")
    private String strategyType;

    @NotBlank(message = "userId is required")
    private String userId;

    @NotBlank(message = "brokerName is required")
    private String brokerName;

    @NotBlank(message = "symbol is required")
    private String symbol;

    @NotBlank(message = "exchange is required")
    private String exchange;

    @NotBlank(message = "product is required")
    private String product;

    @Min(value = 1, message = "quantity must be at least 1")
    private int quantity;

    /** Order type forwarded to Execution Engine. Defaults to MARKET. */
    private String orderType = "MARKET";

    /**
     * Strategy-specific key-value configuration.
     * For SMA_CROSSOVER: {"shortPeriod": "5", "longPeriod": "20"}
     */
    private Map<String, String> parameters;

    /**
     * Allow shorting. When true, SELL signals open short positions; BUY signals cover them.
     * Requires product = MIS or NRML. Defaults to false (long-only).
     */
    private boolean allowShorting = false;
}
