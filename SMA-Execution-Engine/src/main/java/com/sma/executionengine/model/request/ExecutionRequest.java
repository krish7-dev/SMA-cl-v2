package com.sma.executionengine.model.request;

import com.sma.executionengine.entity.ExecutionRecord.OrderType;
import com.sma.executionengine.entity.ExecutionRecord.Product;
import com.sma.executionengine.entity.ExecutionRecord.Side;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import lombok.Data;

import java.math.BigDecimal;

/**
 * Incoming order intent from Strategy Engine or any upstream system.
 *
 * intentId is the caller's idempotency key — submitting the same intentId
 * twice will return the existing ExecutionRecord without re-submitting.
 */
@Data
public class ExecutionRequest {

    /**
     * Caller-supplied idempotency key.
     * Use a stable, deterministic ID (e.g. "strategy-X-signal-Y-YYYYMMDD").
     */
    @NotBlank
    private String intentId;

    @NotBlank
    private String userId;

    @NotBlank
    private String brokerName;

    @NotBlank
    private String symbol;

    @NotBlank
    private String exchange;

    @NotNull
    private Side side;

    @NotNull
    private OrderType orderType;

    @NotNull
    private Product product;

    @NotNull
    @Positive
    private Integer quantity;

    /** Required for LIMIT and SL orders. */
    private BigDecimal price;

    /** Required for SL and SL_M orders. */
    private BigDecimal triggerPrice;

    private String validity;

    private String tag;

    /**
     * Optional: caller-specified maximum notional value for this order.
     * When non-null, overrides the global risk.max-notional-per-order setting.
     */
    private BigDecimal maxNotional;
}
