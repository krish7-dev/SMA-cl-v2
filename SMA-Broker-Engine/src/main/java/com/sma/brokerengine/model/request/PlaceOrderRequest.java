package com.sma.brokerengine.model.request;

import com.sma.brokerengine.entity.OrderRecord.OrderType;
import com.sma.brokerengine.entity.OrderRecord.Product;
import com.sma.brokerengine.entity.OrderRecord.TransactionType;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import lombok.Data;

import java.math.BigDecimal;

@Data
public class PlaceOrderRequest {

    /**
     * Caller-supplied idempotency key. Duplicate requests with the same key
     * will return the existing order rather than placing a new one.
     */
    @NotBlank
    private String clientOrderId;

    @NotBlank
    private String userId;

    @NotBlank
    private String brokerName;

    @NotBlank
    private String symbol;

    @NotBlank
    private String exchange;

    @NotNull
    private TransactionType transactionType;

    @NotNull
    private OrderType orderType;

    @NotNull
    private Product product;

    @NotNull
    @Positive
    private Integer quantity;

    private BigDecimal price;

    private BigDecimal triggerPrice;

    private String validity;

    private String tag;
}
