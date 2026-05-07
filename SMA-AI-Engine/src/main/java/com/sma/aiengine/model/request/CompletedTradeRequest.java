package com.sma.aiengine.model.request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.math.BigDecimal;

@Data
@EqualsAndHashCode(callSuper = true)
public class CompletedTradeRequest extends TradeCandidateRequest {

    @NotBlank
    private String tradeId;

    // Stored as LocalDateTime strings ("2026-04-29T09:55") from Strategy Engine
    private String entryTime;
    private String exitTime;

    private BigDecimal exitPrice;
    private BigDecimal pnl;
    private Double pnlPct;
    private Integer barsHeld;
    private String exitReason;
    private Double maxFavorableExcursionPct;
    private Double maxAdverseExcursionPct;
    private BigDecimal capitalAfter;
    private Double dailyPnlAfterTrade;      // realized P&L including this trade

    // TODO: add candle alignment fields once Strategy Engine sends them for completed trades:
    // instrumentContext, recentCandlesSupportTradeCount, recentCandlesOpposeTradeCount,
    // lastCandleSupportsTrade, recentMomentumAlignment — would improve review accuracy for
    // OVEREXTENSION_AUTO detection and reversal trap classification in normalizeReview().
}
