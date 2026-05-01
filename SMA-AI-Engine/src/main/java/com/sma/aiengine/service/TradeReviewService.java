package com.sma.aiengine.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.aiengine.client.OpenAiClient;
import com.sma.aiengine.client.OpenAiClient.OpenAiException;
import com.sma.aiengine.config.OpenAiConfig;
import com.sma.aiengine.entity.TradeReviewRecord;
import com.sma.aiengine.model.enums.AiSource;
import com.sma.aiengine.model.enums.MistakeType;
import com.sma.aiengine.model.enums.TradeQuality;
import com.sma.aiengine.model.request.CompletedTradeRequest;
import com.sma.aiengine.model.response.TradeReviewResponse;
import com.sma.aiengine.repository.TradeReviewRepository;
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
public class TradeReviewService {

    private static final String SYSTEM_PROMPT = """
            You are a trade quality reviewer for Indian equities and options.
            Analyze the provided completed trade snapshot and return ONLY valid JSON matching this exact schema.
            All fields are required. Use UNKNOWN for enum fields when data is insufficient.
            Clamp confidence between 0.0 and 1.0. Do not hallucinate data not present in the input.

            Required JSON schema:
            {
              "quality": "GOOD | AVERAGE | BAD | UNKNOWN",
              "avoidable": true or false,
              "mistakeType": "NONE | LATE_ENTRY | CHOP_ENTRY | REVERSAL_TRAP | OVEREXTENDED_ENTRY | WEAK_SIGNAL | BAD_EXIT | UNKNOWN",
              "confidence": 0.0-1.0,
              "summary": "one or two sentence explanation",
              "whatWorked": ["factor1", "factor2"],
              "whatFailed": ["factor1"],
              "suggestedRule": "a specific rule to backtest based on this trade",
              "reasonCodes": ["UPPERCASE_CODE"],
              "warningCodes": ["UPPERCASE_CODE"]
            }

            quality=GOOD: trade was well-executed and profitable or hit target.
            quality=AVERAGE: trade was acceptable but had room for improvement.
            quality=BAD: trade had significant execution or signal issues.
            avoidable=true: a better rule would have prevented this loss or mistake.
            mistakeType: most significant mistake (NONE if no mistake).
            whatWorked/whatFailed: 1–4 key factors each.
            suggestedRule: specific and actionable, or empty string if no suggestion.
            """;

    private final TradeReviewRepository tradeReviewRepository;
    private final OpenAiClient          openAiClient;
    private final OpenAiConfig          openAiConfig;
    private final FallbackEvaluator     fallbackEvaluator;
    private final ObjectMapper          objectMapper;

    @Transactional
    public TradeReviewResponse review(CompletedTradeRequest request, String incomingRequestId) {
        String requestId = (incomingRequestId != null && !incomingRequestId.isBlank())
                ? incomingRequestId
                : UUID.randomUUID().toString();

        MDC.put("requestId", requestId);
        long start = System.currentTimeMillis();

        String requestJson = safeSerialize(request);
        String errorDetails = null;
        TradeReviewAiOutput output;

        if (openAiConfig.isEnabled()) {
            try {
                String rawContent = openAiClient.chat(SYSTEM_PROMPT, requestJson);
                output = parseAndValidateReview(rawContent);
                log.info("[{}] OpenAI review: tradeId={} quality={}", requestId, request.getTradeId(), output.quality());
            } catch (OpenAiException e) {
                log.warn("[{}] OpenAI review failed — using fallback. error={}", requestId, e.getMessage());
                errorDetails = e.getMessage();
                output = fallbackEvaluator.review(request);
            }
        } else {
            log.debug("[{}] OpenAI disabled — using fallback review", requestId);
            output = fallbackEvaluator.review(request);
        }

        long latencyMs = System.currentTimeMillis() - start;
        AiSource source = (errorDetails == null && openAiConfig.isEnabled())
                ? AiSource.OPENAI
                : AiSource.FALLBACK;

        TradeReviewRecord record = TradeReviewRecord.builder()
                .tradeId(request.getTradeId())
                .sessionId(request.getSessionId())
                .symbol(request.getSymbol())
                .side(request.getSide())
                .regime(request.getRegime())
                .entryTime(request.getEntryTime())
                .exitTime(request.getExitTime())
                .pnl(request.getPnl())
                .pnlPct(request.getPnlPct())
                .exitReason(request.getExitReason())
                .quality(output.quality())
                .avoidable(output.avoidable())
                .mistakeType(output.mistakeType())
                .confidence(output.confidence())
                .summary(output.summary())
                .whatWorked(output.whatWorked())
                .whatFailed(output.whatFailed())
                .suggestedRule(output.suggestedRule())
                .reasonCodes(output.reasonCodes())
                .warningCodes(output.warningCodes())
                .source(source)
                .latencyMs(latencyMs)
                .requestJson(requestJson)
                .errorDetails(errorDetails)
                .requestId(requestId)
                .build();

        record = tradeReviewRepository.save(record);

        TradeReviewResponse response = TradeReviewResponse.from(record);

        // Store the final caller-facing response as responseJson
        record.setResponseJson(safeSerialize(response));

        log.info("[{}] Review complete: tradeId={} quality={} source={} latencyMs={}",
                requestId, request.getTradeId(), output.quality(), source, latencyMs);

        MDC.remove("requestId");
        return response;
    }

    @Transactional(readOnly = true)
    public TradeReviewResponse getById(Long id) {
        TradeReviewRecord record = tradeReviewRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("Trade review record not found: " + id));
        return TradeReviewResponse.from(record);
    }

    @Transactional(readOnly = true)
    public List<TradeReviewResponse> list(String sessionId, String symbol, String tradeId) {
        if (sessionId != null && !sessionId.isBlank() && tradeId != null && !tradeId.isBlank()) {
            return tradeReviewRepository.findBySessionIdAndTradeId(sessionId, tradeId)
                    .map(TradeReviewResponse::from)
                    .map(List::of)
                    .orElse(List.of());
        }
        List<TradeReviewRecord> records;
        if (sessionId != null && !sessionId.isBlank() && symbol != null && !symbol.isBlank()) {
            records = tradeReviewRepository.findBySessionIdAndSymbolOrderByCreatedAtAsc(sessionId, symbol);
        } else if (sessionId != null && !sessionId.isBlank()) {
            records = tradeReviewRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        } else if (symbol != null && !symbol.isBlank()) {
            records = tradeReviewRepository.findBySymbolOrderByCreatedAtAsc(symbol);
        } else {
            records = tradeReviewRepository.findAllByOrderByCreatedAtAsc();
        }
        return records.stream().map(TradeReviewResponse::from).toList();
    }

    // ── OpenAI response parsing + validation ─────────────────────────────────

    private TradeReviewAiOutput parseAndValidateReview(String content) {
        try {
            Map<?, ?> raw = objectMapper.readValue(content, Map.class);

            TradeQuality quality       = parseEnum(TradeQuality.class, raw.get("quality"), TradeQuality.UNKNOWN);
            MistakeType mistakeType    = parseEnum(MistakeType.class, raw.get("mistakeType"), MistakeType.UNKNOWN);
            boolean avoidable          = raw.get("avoidable") instanceof Boolean b && b;
            double confidence          = clamp(raw.get("confidence"));
            String summary             = raw.get("summary") instanceof String s ? s : "";
            List<String> whatWorked    = parseStringList(raw.get("whatWorked"));
            List<String> whatFailed    = parseStringList(raw.get("whatFailed"));
            String suggestedRule       = raw.get("suggestedRule") instanceof String s ? s : "";
            List<String> reasonCodes   = parseStringList(raw.get("reasonCodes"));
            List<String> warningCodes  = parseStringList(raw.get("warningCodes"));

            return new TradeReviewAiOutput(quality, avoidable, mistakeType, confidence,
                    summary, whatWorked, whatFailed, suggestedRule, reasonCodes, warningCodes);

        } catch (Exception e) {
            log.warn("Failed to parse OpenAI review response — falling back. error={}", e.getMessage());
            throw new OpenAiException("Review JSON parse failed: " + e.getMessage(), e);
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
