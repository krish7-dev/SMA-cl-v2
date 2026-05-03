package com.sma.aiengine.model.response;

import com.sma.aiengine.entity.AdvisoryRecord;
import com.sma.aiengine.model.enums.AdvisoryAction;
import com.sma.aiengine.model.enums.AiSource;
import com.sma.aiengine.model.enums.RiskLevel;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;
import java.util.List;

@Getter
@Builder
public class AdvisoryResponse {

    private Long id;
    private String sessionId;
    private String symbol;
    private String side;
    private String regime;
    private Instant candleTime;

    private AdvisoryAction action;
    private Double confidence;
    private Double tradeQualityScore;
    private RiskLevel riskLevel;
    private Double reversalRisk;
    private Double chopRisk;
    private Double lateEntryRisk;
    private Double overextensionRisk;
    private List<String> reasonCodes;
    private List<String> warningCodes;
    private String summary;

    private AiSource source;
    private Long latencyMs;
    private String requestId;
    private Instant createdAt;
    private String requestJson;
    private String responseJson;
    private String rawResponseJson;
    private Boolean normalized;
    private List<String> normalizationReasons;
    private String aiModel;
    private String aiApiMode;
    private String aiPromptMode;
    private String errorDetails;
    private String errorCategory;

    public static AdvisoryResponse from(AdvisoryRecord r) {
        return AdvisoryResponse.builder()
                .id(r.getId())
                .sessionId(r.getSessionId())
                .symbol(r.getSymbol())
                .side(r.getSide())
                .regime(r.getRegime())
                .candleTime(r.getCandleTime())
                .action(r.getAction())
                .confidence(r.getConfidence())
                .tradeQualityScore(r.getTradeQualityScore())
                .riskLevel(r.getRiskLevel())
                .reversalRisk(r.getReversalRisk())
                .chopRisk(r.getChopRisk())
                .lateEntryRisk(r.getLateEntryRisk())
                .overextensionRisk(r.getOverextensionRisk())
                .reasonCodes(r.getReasonCodes() != null ? r.getReasonCodes() : List.of())
                .warningCodes(r.getWarningCodes() != null ? r.getWarningCodes() : List.of())
                .summary(r.getSummary() != null ? r.getSummary() : "")
                .source(r.getSource())
                .latencyMs(r.getLatencyMs())
                .requestId(r.getRequestId())
                .createdAt(r.getCreatedAt())
                .requestJson(r.getRequestJson())
                .responseJson(r.getResponseJson())
                .rawResponseJson(r.getRawResponseJson())
                .normalized(r.getNormalized())
                .normalizationReasons(r.getNormalizationReasons() != null ? r.getNormalizationReasons() : List.of())
                .aiModel(r.getAiModel())
                .aiApiMode(r.getAiApiMode())
                .aiPromptMode(r.getAiPromptMode())
                .errorDetails(r.getErrorDetails())
                .errorCategory(r.getErrorCategory())
                .build();
    }
}
