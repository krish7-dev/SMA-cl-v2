package com.sma.aiengine.model.request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.math.BigDecimal;
import java.time.Instant;

@Data
@EqualsAndHashCode(callSuper = true)
public class CompletedTradeRequest extends TradeCandidateRequest {

    @NotBlank
    private String tradeId;

    private Instant entryTime;
    private Instant exitTime;
    private BigDecimal exitPrice;
    private BigDecimal pnl;
    private Double pnlPct;
    private Integer barsHeld;
    private String exitReason;
    private Double maxFavorableExcursionPct;
    private Double maxAdverseExcursionPct;
    private BigDecimal capitalAfter;
}
