package com.sma.aiengine.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.aiengine.client.OpenAiClient;
import com.sma.aiengine.client.OpenAiClient.OpenAiException;
import com.sma.aiengine.config.OpenAiConfig;
import com.sma.aiengine.entity.AdvisoryRecord;
import com.sma.aiengine.model.enums.AdvisoryAction;
import com.sma.aiengine.model.enums.AiSource;
import com.sma.aiengine.model.enums.RiskLevel;
import com.sma.aiengine.model.request.TradeCandidateRequest;
import com.sma.aiengine.model.response.AdvisoryResponse;
import com.sma.aiengine.repository.AdvisoryRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class AdvisoryService {

    private static final String SYSTEM_PROMPT = """
            You are a quantitative trade analyst for Indian equities and options.
            Analyze the provided trade candidate snapshot and return ONLY valid JSON matching this exact schema.
            All fields are required. Use UNKNOWN for enum fields when data is insufficient.
            Clamp all numeric risk scores between 0.0 and 1.0. Do not hallucinate market data not present in the input.

            Required JSON schema:
            {
              "action": "ALLOW | CAUTION | AVOID | UNKNOWN",
              "confidence": 0.0-1.0,
              "tradeQualityScore": 0.0-1.0,
              "riskLevel": "LOW | MEDIUM | HIGH | UNKNOWN",
              "reversalRisk": 0.0-1.0,
              "chopRisk": 0.0-1.0,
              "lateEntryRisk": 0.0-1.0,
              "overextensionRisk": 0.0-1.0,
              "reasonCodes": ["UPPERCASE_CODE"],
              "warningCodes": ["UPPERCASE_CODE"],
              "summary": "one or two sentence explanation"
            }

            action=ALLOW: setup is acceptable to proceed.
            action=CAUTION: setup has notable risks but may proceed.
            action=AVOID: too risky, do not trade.
            action=UNKNOWN: insufficient data to judge.
            reasonCodes: short uppercase strings explaining the action (e.g. STRONG_SCORE_GAP, COMPRESSION_REGIME).
            warningCodes: risks present even when action=ALLOW (e.g. LATE_ENTRY, HIGH_ADX).
            """;

    private final AdvisoryRepository   advisoryRepository;
    private final OpenAiClient         openAiClient;
    private final OpenAiConfig         openAiConfig;
    private final FallbackEvaluator    fallbackEvaluator;
    private final ObjectMapper         objectMapper;

    @Transactional
    public AdvisoryResponse advise(TradeCandidateRequest request, String incomingRequestId) {
        String requestId = (incomingRequestId != null && !incomingRequestId.isBlank())
                ? incomingRequestId
                : UUID.randomUUID().toString();

        MDC.put("requestId", requestId);
        long start = System.currentTimeMillis();

        String requestJson = safeSerialize(request);
        String errorDetails = null;
        AdvisoryAiOutput output;

        if (openAiConfig.isEnabled()) {
            try {
                String rawContent = openAiClient.chat(SYSTEM_PROMPT, requestJson);
                output = parseAndValidateAdvisory(rawContent);
                log.info("[{}] OpenAI advisory: symbol={} action={}", requestId, request.getSymbol(), output.action());
            } catch (OpenAiException e) {
                log.warn("[{}] OpenAI advisory failed — using fallback. error={}", requestId, e.getMessage());
                errorDetails = e.getMessage();
                output = fallbackEvaluator.advisory(request);
            }
        } else {
            log.debug("[{}] OpenAI disabled — using fallback advisory", requestId);
            output = fallbackEvaluator.advisory(request);
        }

        long latencyMs = System.currentTimeMillis() - start;
        AiSource source = (errorDetails == null && openAiConfig.isEnabled())
                ? AiSource.OPENAI
                : AiSource.FALLBACK;

        // Serialize AI output as responseJson before save — avoids a second DB round-trip
        String responseJson = safeSerialize(output);

        // Upsert: re-running the same tick session replaces the previous advisory for this candle
        AdvisoryRecord record = advisoryRepository
                .findBySessionIdAndCandleTime(request.getSessionId(), request.getCandleTime())
                .orElseGet(() -> AdvisoryRecord.builder()
                        .sessionId(request.getSessionId())
                        .symbol(request.getSymbol())
                        .side(request.getSide())
                        .regime(request.getRegime())
                        .candleTime(request.getCandleTime())
                        .build());

        record.setAction(output.action());
        record.setConfidence(output.confidence());
        record.setTradeQualityScore(output.tradeQualityScore());
        record.setRiskLevel(output.riskLevel());
        record.setReversalRisk(output.reversalRisk());
        record.setChopRisk(output.chopRisk());
        record.setLateEntryRisk(output.lateEntryRisk());
        record.setOverextensionRisk(output.overextensionRisk());
        record.setReasonCodes(output.reasonCodes());
        record.setWarningCodes(output.warningCodes());
        record.setSummary(output.summary());
        record.setSource(source);
        record.setLatencyMs(latencyMs);
        record.setRequestJson(requestJson);
        record.setResponseJson(responseJson);
        record.setErrorDetails(errorDetails);
        record.setRequestId(requestId);

        record = advisoryRepository.save(record);

        AdvisoryResponse response = AdvisoryResponse.from(record);

        log.info("[{}] Advisory complete: symbol={} action={} source={} latencyMs={}",
                requestId, request.getSymbol(), output.action(), source, latencyMs);

        MDC.remove("requestId");
        return response;
    }

    @Transactional(readOnly = true)
    public AdvisoryResponse getById(Long id) {
        AdvisoryRecord record = advisoryRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("Advisory record not found: " + id));
        return AdvisoryResponse.from(record);
    }

    @Transactional(readOnly = true)
    public List<AdvisoryResponse> list(String sessionId, String symbol) {
        List<AdvisoryRecord> records;

        if (sessionId != null && !sessionId.isBlank() && symbol != null && !symbol.isBlank()) {
            records = advisoryRepository.findBySessionIdAndSymbolOrderByCreatedAtAsc(sessionId, symbol);
        } else if (sessionId != null && !sessionId.isBlank()) {
            records = advisoryRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        } else if (symbol != null && !symbol.isBlank()) {
            records = advisoryRepository.findBySymbolOrderByCreatedAtAsc(symbol);
        } else {
            records = advisoryRepository.findAllByOrderByCreatedAtAsc();
        }

        return records.stream().map(AdvisoryResponse::from).toList();
    }

    // ── OpenAI response parsing + validation ─────────────────────────────────

    private AdvisoryAiOutput parseAndValidateAdvisory(String content) {
        try {
            Map<?, ?> raw = objectMapper.readValue(content, Map.class);

            AdvisoryAction action         = parseEnum(AdvisoryAction.class, raw.get("action"), AdvisoryAction.UNKNOWN);
            RiskLevel riskLevel           = parseEnum(RiskLevel.class, raw.get("riskLevel"), RiskLevel.UNKNOWN);
            double confidence             = clamp(raw.get("confidence"));
            double tradeQualityScore      = clamp(raw.get("tradeQualityScore"));
            double reversalRisk           = clamp(raw.get("reversalRisk"));
            double chopRisk               = clamp(raw.get("chopRisk"));
            double lateEntryRisk          = clamp(raw.get("lateEntryRisk"));
            double overextensionRisk      = clamp(raw.get("overextensionRisk"));
            List<String> reasonCodes      = parseStringList(raw.get("reasonCodes"));
            List<String> warningCodes     = parseStringList(raw.get("warningCodes"));
            String summary                = raw.get("summary") instanceof String s ? s : "";

            return new AdvisoryAiOutput(action, confidence, tradeQualityScore, riskLevel,
                    reversalRisk, chopRisk, lateEntryRisk, overextensionRisk,
                    reasonCodes, warningCodes, summary);

        } catch (Exception e) {
            log.warn("Failed to parse OpenAI advisory response — falling back. error={}", e.getMessage());
            throw new OpenAiException("Advisory JSON parse failed: " + e.getMessage(), e);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private <E extends Enum<E>> E parseEnum(Class<E> cls, Object value, E defaultVal) {
        if (!(value instanceof String s)) return defaultVal;
        try { return Enum.valueOf(cls, s.toUpperCase()); }
        catch (IllegalArgumentException e) { return defaultVal; }
    }

    private double clamp(Object value) {
        if (!(value instanceof Number n)) return 0.0;
        return Math.max(0.0, Math.min(1.0, n.doubleValue()));
    }

    @SuppressWarnings("unchecked")
    private List<String> parseStringList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        return list.stream()
                .filter(item -> item instanceof String)
                .map(item -> (String) item)
                .toList();
    }

    private String safeSerialize(Object obj) {
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (Exception e) {
            log.warn("Failed to serialize object to JSON: {}", e.getMessage());
            return "{}";
        }
    }
}
