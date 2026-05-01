package com.sma.aiengine.model.response;

import com.sma.aiengine.entity.TradeReviewRecord;
import com.sma.aiengine.model.enums.AiSource;
import com.sma.aiengine.model.enums.MistakeType;
import com.sma.aiengine.model.enums.TradeQuality;
import lombok.Builder;
import lombok.Getter;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

@Getter
@Builder
public class TradeReviewResponse {

    private Long id;
    private String tradeId;
    private String sessionId;
    private String symbol;
    private String side;
    private String regime;
    private Instant entryTime;
    private Instant exitTime;
    private BigDecimal pnl;
    private Double pnlPct;
    private String exitReason;

    private TradeQuality quality;
    private Boolean avoidable;
    private MistakeType mistakeType;
    private Double confidence;
    private String summary;
    private List<String> whatWorked;
    private List<String> whatFailed;
    private String suggestedRule;
    private List<String> reasonCodes;
    private List<String> warningCodes;

    private AiSource source;
    private Long latencyMs;
    private String requestId;
    private Instant createdAt;

    public static TradeReviewResponse from(TradeReviewRecord r) {
        return TradeReviewResponse.builder()
                .id(r.getId())
                .tradeId(r.getTradeId())
                .sessionId(r.getSessionId())
                .symbol(r.getSymbol())
                .side(r.getSide())
                .regime(r.getRegime())
                .entryTime(r.getEntryTime())
                .exitTime(r.getExitTime())
                .pnl(r.getPnl())
                .pnlPct(r.getPnlPct())
                .exitReason(r.getExitReason())
                .quality(r.getQuality())
                .avoidable(r.getAvoidable())
                .mistakeType(r.getMistakeType())
                .confidence(r.getConfidence())
                .summary(r.getSummary() != null ? r.getSummary() : "")
                .whatWorked(r.getWhatWorked() != null ? r.getWhatWorked() : List.of())
                .whatFailed(r.getWhatFailed() != null ? r.getWhatFailed() : List.of())
                .suggestedRule(r.getSuggestedRule() != null ? r.getSuggestedRule() : "")
                .reasonCodes(r.getReasonCodes() != null ? r.getReasonCodes() : List.of())
                .warningCodes(r.getWarningCodes() != null ? r.getWarningCodes() : List.of())
                .source(r.getSource())
                .latencyMs(r.getLatencyMs())
                .requestId(r.getRequestId())
                .createdAt(r.getCreatedAt())
                .build();
    }
}
