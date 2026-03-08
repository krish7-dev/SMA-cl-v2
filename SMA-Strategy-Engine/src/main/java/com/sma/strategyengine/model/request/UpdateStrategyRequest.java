package com.sma.strategyengine.model.request;

import jakarta.validation.constraints.Min;
import lombok.Data;

import java.util.Map;

/**
 * Partial-update request for a strategy instance.
 * Only non-null fields are applied — null means "leave unchanged".
 */
@Data
public class UpdateStrategyRequest {

    /** Rename the instance. */
    private String name;

    /** Replace all strategy parameters. */
    private Map<String, String> parameters;

    @Min(value = 1, message = "quantity must be at least 1")
    private Integer quantity;

    private String product;

    private String orderType;
}
