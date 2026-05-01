package com.sma.aiengine.model.request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

import java.math.BigDecimal;
import java.time.Instant;

@Data
public class TradeCandidateRequest {

    @NotBlank
    private String sessionId;

    @NotBlank
    private String symbol;

    @NotBlank
    private String side;

    private Instant candleTime;

    private BigDecimal entryPrice;
    private Integer quantity;

    private String regime;
    private String winningStrategy;
    private Double winningScore;
    private Double oppositeScore;
    private Double scoreGap;

    private Double recentMove3CandlePct;
    private Double recentMove5CandlePct;
    private Double vwapDistancePct;
    private Double candleBodyPct;
    private Double adx;
    private Double atrPct;

    private BigDecimal optionPremium;

    private Integer barsSinceLastTrade;
    private Integer tradesToday;
    private BigDecimal dailyPnl;
    private BigDecimal capitalBefore;

    private Boolean compressionNoTradeEnabled;
    private Boolean minMovementFilterPassed;
    private Boolean directionalConsistencyPassed;
    private Boolean candleStrengthFilterPassed;
}
