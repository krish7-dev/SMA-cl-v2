package com.sma.brokerengine.model.response;

import lombok.Builder;
import lombok.Data;

import java.math.BigDecimal;

@Data
@Builder
public class PositionResponse {

    private String symbol;
    private String exchange;
    private String product;
    private Integer quantity;
    private Integer overnightQuantity;
    private BigDecimal averagePrice;
    private BigDecimal lastPrice;
    private BigDecimal pnl;
    private BigDecimal unrealisedPnl;
    private BigDecimal realisedPnl;
    private BigDecimal value;
    private BigDecimal buyPrice;
    private BigDecimal sellPrice;
    private Integer buyQuantity;
    private Integer sellQuantity;
}
