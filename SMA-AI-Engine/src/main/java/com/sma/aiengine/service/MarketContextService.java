package com.sma.aiengine.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.aiengine.client.OpenAiClient;
import com.sma.aiengine.client.OpenAiClient.OpenAiException;
import com.sma.aiengine.config.OpenAiConfig;
import com.sma.aiengine.entity.MarketContextRecord;
import com.sma.aiengine.model.enums.AiSource;
import com.sma.aiengine.model.request.MarketContextRequest;
import com.sma.aiengine.model.response.ApiResponse;
import com.sma.aiengine.model.response.MarketContextResponse;
import com.sma.aiengine.repository.MarketContextRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class MarketContextService {

    private static final String SYSTEM_PROMPT = """
            You are a quantitative market analyst evaluating NIFTY 50 market conditions for intraday options trading.
            Your task: decide whether the market is tradable right now, and whether CE (call) or PE (put) entries should be avoided.

            In this system:
            - CE = call option (bullish — profits when NIFTY rises)
            - PE = put option (bearish — profits when NIFTY falls)
            - regime values: COMPRESSION / TRENDING / VOLATILE / RANGING
            - shortTermTrend values: UPTREND / DOWNTREND / SIDEWAYS

            DECISION ORDER — you MUST follow this exactly:
            1. Set marketTradable, avoidCE, avoidPE using the mandatory rules below.
            2. Build reasonCodes and warningCodes to explain your decision.
            3. ONLY THEN write the summary — it must reflect the booleans you set, not contradict them.
               If avoidPE=true, the summary MUST say "avoid PE" or "avoid puts" (not just imply it).
               If avoidCE=true, the summary MUST say "avoid CE" or "avoid calls".

            MANDATORY boolean rules (these are hard constraints, not guidelines):
            1. COMPRESSION regime → marketTradable MUST be false. Add COMPRESSION_REGIME to reasonCodes.
            2. RANGING regime → marketTradable MUST be false. Add RANGING_REGIME to reasonCodes.
            3. TRENDING + adx >= 25 → marketTradable SHOULD be true. Add TRENDING_STRONG_ADX to reasonCodes.
            4. downCandlesCount >= 4 → avoidCE MUST be true. Add BEARISH_CANDLE_FLOW to reasonCodes.
            5. upCandlesCount >= 4 → avoidPE MUST be true. Add BULLISH_CANDLE_FLOW to reasonCodes.

            avoidCE and avoidPE are INDEPENDENT of marketTradable. Both can be true simultaneously.
            Example: COMPRESSION + 4 up candles → marketTradable=false AND avoidPE=true.

            CRITICAL UNIT RULE: recentMove3/5CandlePct are already % values — 0.28 = 0.28%, NOT 28%.
            Only flag overextension when recentMove3CandlePct >= 1.5 or recentMove5CandlePct >= 2.5.

            Return ONLY valid JSON — no markdown, no text outside the JSON object:
            {
              "marketTradable": true | false,
              "avoidCE": true | false,
              "avoidPE": true | false,
              "confidence": 0.0-1.0,
              "summary": "1-2 sentences describing what you decided and why. Must match the booleans.",
              "reasonCodes": ["UPPERCASE_SNAKE_CASE"],
              "warningCodes": ["UPPERCASE_SNAKE_CASE"]
            }
            Clamp confidence to [0.0, 1.0]. Do not hallucinate data not present in the input.
            """;

    private static final Map<String, Object> MARKET_CTX_SCHEMA = Map.ofEntries(
        Map.entry("type", "object"),
        Map.entry("additionalProperties", false),
        Map.entry("required", List.of(
                "marketTradable", "avoidCE", "avoidPE", "confidence",
                "summary", "reasonCodes", "warningCodes")),
        Map.entry("properties", Map.ofEntries(
                Map.entry("marketTradable", Map.of("type", "boolean")),
                Map.entry("avoidCE",        Map.of("type", "boolean")),
                Map.entry("avoidPE",        Map.of("type", "boolean")),
                Map.entry("confidence",     Map.of("type", "number")),
                Map.entry("summary",        Map.of("type", "string")),
                Map.entry("reasonCodes",    Map.of("type", "array",
                        "items", Map.of("type", "string"))),
                Map.entry("warningCodes",   Map.of("type", "array",
                        "items", Map.of("type", "string")))
        ))
    );

    private final MarketContextRepository marketContextRepository;
    private final OpenAiClient            openAiClient;
    private final OpenAiConfig            openAiConfig;
    private final FallbackEvaluator       fallbackEvaluator;
    private final ObjectMapper            objectMapper;

    @Transactional
    public ApiResponse<MarketContextResponse> evaluate(MarketContextRequest request, String incomingRequestId) {
        String requestId = (incomingRequestId != null && !incomingRequestId.isBlank())
                ? incomingRequestId
                : UUID.randomUUID().toString();

        MDC.put("requestId", requestId);
        long start = System.currentTimeMillis();

        String requestJson  = safeSerialize(request);
        String errorDetails = null;
        MarketContextResponse output;

        if (openAiConfig.isEnabled()) {
            try {
                log.info("[{}] AI market-context call: model={} apiMode={}", requestId,
                        openAiConfig.getModel(), openAiConfig.getApiMode());
                String rawContent = openAiClient.chat(
                        SYSTEM_PROMPT, requestJson, "market_context_response", MARKET_CTX_SCHEMA);
                output = parseResponse(rawContent, requestId);
                output.setSource("OPENAI");
                output = normalizeMarketContext(request, output);
                log.info("[{}] Market context: tradable={} avoidCE={} avoidPE={} conf={}",
                        requestId, output.isMarketTradable(), output.isAvoidCE(),
                        output.isAvoidPE(), output.getConfidence());
            } catch (OpenAiException e) {
                log.warn("[{}] OpenAI market-context failed — using fallback. error={}", requestId, e.getMessage());
                errorDetails = e.getMessage();
                output = normalizeMarketContext(request, fallbackEvaluator.marketContext(request));
            }
        } else {
            log.debug("[{}] OpenAI disabled — using fallback market context", requestId);
            output = normalizeMarketContext(request, fallbackEvaluator.marketContext(request));
        }

        long latencyMs = System.currentTimeMillis() - start;
        AiSource source = (errorDetails == null && openAiConfig.isEnabled())
                ? AiSource.OPENAI : AiSource.FALLBACK;

        String responseJson = safeSerialize(output);

        // Upsert on (session_id, candle_time)
        MarketContextRecord record = request.getCandleTime() != null
                ? marketContextRepository
                        .findBySessionIdAndCandleTime(request.getSessionId(), request.getCandleTime())
                        .orElse(new MarketContextRecord())
                : new MarketContextRecord();

        record.setSessionId(request.getSessionId());
        record.setCandleTime(request.getCandleTime());
        record.setRegime(request.getRegime());
        record.setMarketTradable(output.isMarketTradable());
        record.setAvoidCe(output.isAvoidCE());
        record.setAvoidPe(output.isAvoidPE());
        record.setConfidence(output.getConfidence());
        record.setSummary(output.getSummary());
        record.setReasonCodes(output.getReasonCodes());
        record.setWarningCodes(output.getWarningCodes());
        record.setSource(source);
        record.setLatencyMs(latencyMs);
        record.setRequestJson(requestJson);
        record.setResponseJson(responseJson);
        record.setRequestId(requestId);
        record.setAiModel(openAiConfig.isEnabled() ? openAiConfig.getModel() : null);
        record.setAiPromptMode(openAiConfig.isEnabled() ? openAiConfig.getPromptMode() : null);

        marketContextRepository.save(record);

        return ApiResponse.ok(output, "Market context evaluated");
    }

    public List<MarketContextResponse> listBySession(String sessionId) {
        return marketContextRepository.findBySessionIdOrderByCandleTimeDesc(sessionId)
                .stream()
                .map(r -> MarketContextResponse.builder()
                        .marketTradable(Boolean.TRUE.equals(r.getMarketTradable()))
                        .avoidCE(Boolean.TRUE.equals(r.getAvoidCe()))
                        .avoidPE(Boolean.TRUE.equals(r.getAvoidPe()))
                        .confidence(r.getConfidence() != null ? r.getConfidence() : 0.0)
                        .summary(r.getSummary())
                        .reasonCodes(r.getReasonCodes())
                        .warningCodes(r.getWarningCodes())
                        .source(r.getSource() != null ? r.getSource().name() : null)
                        .build())
                .toList();
    }

    @SuppressWarnings("unchecked")
    private MarketContextResponse parseResponse(String rawContent, String requestId) {
        try {
            JsonNode root = objectMapper.readTree(rawContent);
            boolean marketTradable = root.path("marketTradable").asBoolean(true);
            boolean avoidCE        = root.path("avoidCE").asBoolean(false);
            boolean avoidPE        = root.path("avoidPE").asBoolean(false);
            double  confidence     = Math.max(0.0, Math.min(1.0, root.path("confidence").asDouble(0.5)));
            String  summary        = root.path("summary").asText("");
            List<String> reasonCodes  = readStringList(root.path("reasonCodes"));
            List<String> warningCodes = readStringList(root.path("warningCodes"));

            return MarketContextResponse.builder()
                    .marketTradable(marketTradable)
                    .avoidCE(avoidCE)
                    .avoidPE(avoidPE)
                    .confidence(confidence)
                    .summary(summary)
                    .reasonCodes(reasonCodes)
                    .warningCodes(warningCodes)
                    .build();
        } catch (Exception e) {
            log.warn("[{}] Failed to parse market context response: {}. Using fallback values.", requestId, e.getMessage());
            return MarketContextResponse.builder()
                    .marketTradable(true).avoidCE(false).avoidPE(false)
                    .confidence(0.5).summary("Parse error — defaulting to tradable.")
                    .reasonCodes(List.of()).warningCodes(List.of("PARSE_ERROR"))
                    .build();
        }
    }

    private List<String> readStringList(JsonNode node) {
        List<String> list = new ArrayList<>();
        if (node.isArray()) {
            node.forEach(el -> { if (el.isTextual()) list.add(el.asText()); });
        }
        return list;
    }

    private MarketContextResponse normalizeMarketContext(MarketContextRequest req, MarketContextResponse res) {
        if (res == null) res = new MarketContextResponse();

        List<String> reasons  = new ArrayList<>(res.getReasonCodes()  != null ? res.getReasonCodes()  : List.of());
        List<String> warnings = new ArrayList<>(res.getWarningCodes() != null ? res.getWarningCodes() : List.of());

        String regime = req.getRegime() == null ? "" : req.getRegime().trim().toUpperCase();

        // ── Candle flow — hard override ───────────────────────────────────
        if (req.getUpCandlesCount() >= 4 && !res.isAvoidPE()) {
            res.setAvoidPE(true);
            addIfMissing(reasons, "BULLISH_CANDLE_FLOW");
            res.setConfidence(Math.max(res.getConfidence(), 0.70));
            log.info("Normalized: avoidPE false→true (BULLISH_CANDLE_FLOW up={}) sid={} t={}",
                    req.getUpCandlesCount(), req.getSessionId(), req.getCandleTime());
        }
        if (req.getDownCandlesCount() >= 4 && !res.isAvoidCE()) {
            res.setAvoidCE(true);
            addIfMissing(reasons, "BEARISH_CANDLE_FLOW");
            res.setConfidence(Math.max(res.getConfidence(), 0.70));
            log.info("Normalized: avoidCE false→true (BEARISH_CANDLE_FLOW down={}) sid={} t={}",
                    req.getDownCandlesCount(), req.getSessionId(), req.getCandleTime());
        }

        // ── Regime — hard override ────────────────────────────────────────
        if ("COMPRESSION".equals(regime) && res.isMarketTradable()) {
            res.setMarketTradable(false);
            addIfMissing(reasons, "COMPRESSION_REGIME");
            res.setConfidence(Math.max(res.getConfidence(), 0.80));
            log.info("Normalized: marketTradable true→false (COMPRESSION) sid={}", req.getSessionId());
        }
        if ("RANGING".equals(regime) && res.isMarketTradable()) {
            res.setMarketTradable(false);
            addIfMissing(reasons, "RANGING_REGIME");
            res.setConfidence(Math.max(res.getConfidence(), 0.65));
            log.info("Normalized: marketTradable true→false (RANGING) sid={}", req.getSessionId());
        }

        // ── Summary contradiction guard ───────────────────────────────────
        if (res.getSummary() != null) {
            String lc = res.getSummary().toLowerCase();
            boolean negated = lc.contains("no need to avoid") || lc.contains("no specific need to avoid")
                    || lc.contains("not necessary to avoid") || lc.contains("not avoid");
            if (!negated) {
                if (!res.isAvoidPE()
                        && (lc.contains("avoid pe") || lc.contains("avoid put") || lc.contains("puts should be avoided"))) {
                    res.setAvoidPE(true);
                    addIfMissing(reasons, "SUMMARY_CONTRADICTION_FIX");
                    log.warn("Normalized: avoidPE false→true from summary contradiction sid={}", req.getSessionId());
                }
                if (!res.isAvoidCE()
                        && (lc.contains("avoid ce") || lc.contains("avoid call") || lc.contains("calls should be avoided"))) {
                    res.setAvoidCE(true);
                    addIfMissing(reasons, "SUMMARY_CONTRADICTION_FIX");
                    log.warn("Normalized: avoidCE false→true from summary contradiction sid={}", req.getSessionId());
                }
            }
        }

        // ── Clamp confidence ──────────────────────────────────────────────
        res.setConfidence(Math.max(0.0, Math.min(1.0, res.getConfidence())));
        res.setReasonCodes(reasons);
        res.setWarningCodes(warnings);
        return res;
    }

    private static void addIfMissing(List<String> list, String code) {
        if (!list.contains(code)) list.add(code);
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
