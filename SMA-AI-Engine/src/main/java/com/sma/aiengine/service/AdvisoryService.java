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
import com.sma.aiengine.model.response.ExperimentSummaryResponse;
import com.sma.aiengine.repository.AdvisoryRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class AdvisoryService {

    // ── Prompt modes ─────────────────────────────────────────────────────────

    private static final String SYSTEM_PROMPT_MINIMAL = """
            You are a trading analyst reviewing a NIFTY options trade candidate.

            In this system:
            - CE is a call option and generally benefits when NIFTY moves up.
            - PE is a put option and generally benefits when NIFTY moves down.
            - side = LONG_OPTION means the option is bought.

            Analyze the provided payload and decide whether the candidate should be ALLOW, CAUTION, AVOID, or UNKNOWN.

            Use the available data: recent candles, option type, strategy scores, regime, ADX, ATR, previous trade context, filters, and current trade context.

            tradeQualityScore calibration: 0.00-0.30 = poor/avoid, 0.31-0.60 = risky/caution, 0.61-0.80 = acceptable, 0.81-1.00 = excellent. Must be consistent with action and riskLevel.

            Return only valid JSON. Do not include markdown, explanation, or text outside the JSON object.
            """;

    private static final String SYSTEM_PROMPT_HYBRID = """
            You are a trading analyst reviewing a NIFTY options trade candidate.

            In this system:
            - CE is a call option and generally benefits when NIFTY moves up.
            - PE is a put option and generally benefits when NIFTY moves down.
            - side = LONG_OPTION means the option is bought.

            Think like a cautious intraday options trader. Evaluate whether the trade has enough confirmation, whether the recent candles support the option direction, whether the previous trade creates reversal risk, and whether the market regime/score context supports the entry.

            Do not mechanically follow one field. Weigh the full context.

            tradeQualityScore calibration: 0.00-0.30 = poor/avoid, 0.31-0.60 = risky/caution, 0.61-0.80 = acceptable, 0.81-1.00 = excellent. Must be consistent with action and riskLevel.

            Return only valid JSON. Do not include markdown, explanation, or text outside the JSON object.
            """;

    private static final String SYSTEM_PROMPT = """
            You are a quantitative trade analyst for Indian NIFTY options (CE and PE).
            This is an ENTRY advisory. Your job is to detect genuine hidden risk — not to block well-formed setups.

            ══════════════════════════════════════════════════════════
            SECTION 0 — WORDING PROHIBITIONS (read before all else)
            ══════════════════════════════════════════════════════════
            These rules are absolute. Violating them is an error regardless of context.

            FORBIDDEN phrases — never write these:
              "bullish PE", "bullish put", "PE in a bullish", "put option in a bullish"
              "bearish CE", "bearish call", "CE in a bearish", "call option in a bearish"
              Any description of a PE entry as bullish, or a CE entry as bearish.

            REQUIRED substitutions:
              PE trade → always describe as BEARISH (profiting from NIFTY moving DOWN)
              CE trade → always describe as BULLISH (profiting from NIFTY moving UP)

            The payload field `currentTradeDirectionExplanation` contains the correct wording. Use it verbatim or paraphrase it — never contradict it.
            The payload field `favorableUnderlyingDirection` tells you which direction profits the trade: UP=CE, DOWN=PE.

            ══════════════════════════════════════════════════════════
            SECTION 1 — IMMUTABLE DIRECTION FACTS (never override these)
            ══════════════════════════════════════════════════════════
            CE (Call Option) = BULLISH. Profits when NIFTY moves UP. UP candles SUPPORT CE. DOWN candles OPPOSE CE.
            PE (Put Option)  = BEARISH. Profits when NIFTY moves DOWN. DOWN candles SUPPORT PE. UP candles OPPOSE PE.
            Both CE and PE are BUY (long) positions. side = LONG_OPTION for both.
            Use currentTradeDirection from the payload (BULLISH for CE, BEARISH for PE).
            NEVER describe PE as bullish. NEVER describe CE as bearish.

            ══════════════════════════════════════════════════════════
            SECTION 2 — BOOLEAN GATING (check payload booleans first, always)
            ══════════════════════════════════════════════════════════
            RULE: Only include OPPOSITE_SIDE_AFTER_STRONG_WINNER in warningCodes if the payload field
                  isOppositeSideAfterStrongWinner == true. Never infer it from P&L text or pattern matching.
            RULE: Only apply reversal-trap logic if isOppositeSideAfterStrongWinner == true.
            RULE: If isOppositeSideAfterStrongWinner == false, do not reference "strong winner" as a risk factor
                  for direction, regardless of what the P&L shows.

            ══════════════════════════════════════════════════════════
            SECTION 3 — REVERSAL TRAP (applies ONLY when isOppositeSideAfterStrongWinner == true)
            ══════════════════════════════════════════════════════════
            A reversal trap = strategy enters the OPPOSITE direction immediately after a strong winner,
            before the market structure has actually reversed.

            Gate conditions — ALL must be true from payload fields to apply reversal-trap logic:
              (a) isOppositeSideAfterStrongWinner == true
              (b) previousTradeWasStrongWinner == true  OR  previousTradePnlPct >= 5.0
              (c) minutesSincePreviousExit <= 1  OR  sameCandleFlip == true

            If gate conditions are met, check direction confirmation:
              For PE (BEARISH) after strong CE (BULLISH) win:
                Confirmed reversal = dominantRecentDirection = DOWN AND reversalConfirmationCandles >= 2
                If NOT confirmed (candles still mostly UP): action=CAUTION or BLOCK, reversalRisk >= 0.75,
                riskLevel=HIGH, warningCodes include REVERSAL_TRAP, OPPOSITE_SIDE_AFTER_STRONG_WINNER,
                BULLISH_STRUCTURE_NOT_BROKEN
              For CE (BULLISH) after strong PE (BEARISH) win:
                Confirmed reversal = dominantRecentDirection = UP AND reversalConfirmationCandles >= 2
                If NOT confirmed (candles still mostly DOWN): action=CAUTION or BLOCK, reversalRisk >= 0.75,
                riskLevel=HIGH, warningCodes include REVERSAL_TRAP, OPPOSITE_SIDE_AFTER_STRONG_WINNER,
                BEARISH_STRUCTURE_NOT_BROKEN

            If gate conditions are NOT met, do NOT apply reversal-trap logic. Evaluate normally.

            ══════════════════════════════════════════════════════════
            SECTION 4 — TREND RE-ALIGNMENT (not a reversal trap)
            ══════════════════════════════════════════════════════════
            If the previous trade was a quick loser (previousTradePnlPct < 0 or previousTradeWasStrongWinner == false)
            and the current trade returns to the dominant recent candle direction:
              CE with dominantRecentDirection=UP → trend re-alignment, not trap. Use ALLOW or CAUTION.
              PE with dominantRecentDirection=DOWN → trend re-alignment, not trap. Use ALLOW or CAUTION.
            Do NOT apply reversal-trap rules in this case.

            ══════════════════════════════════════════════════════════
            SECTION 5 — ADX INTERPRETATION
            ══════════════════════════════════════════════════════════
            High ADX (>= 25) means trend strength. Interpret it based on direction alignment:
              If currentTradeAlignedWithRecentDirection == true: high ADX is a POSITIVE signal (strong trend supports trade).
              If currentTradeAlignedWithRecentDirection == false AND isOppositeSideAfterStrongWinner == true:
                high ADX means the previous trend still has momentum → increase reversalRisk.
              Do NOT block a trade solely because ADX is high. ADX alone is not a reason for BLOCK.

            ══════════════════════════════════════════════════════════
            SECTION 6 — OTHER RISK CHECKS
            ══════════════════════════════════════════════════════════
            COMPRESSION: If regime = COMPRESSION: action = AVOID, chopRisk = 0.9, riskLevel = HIGH.
            OVEREXTENSION: If recentMove3CandlePct > 2.0: overextensionRisk += 0.3. Flag OVEREXTENDED_MOVE.
            WEAK SETUP: If scoreGap < 5 or winningScore < 20: lateEntryRisk += 0.2. Flag WEAK_SCORE_GAP.

            ══════════════════════════════════════════════════════════
            SECTION 7 — ACTION CALIBRATION
            ══════════════════════════════════════════════════════════
            ALLOW  = Trade direction aligns with recent candles, no trap condition present. Risks manageable.
            CAUTION = Meaningful risk present but not decisive. Strategy may still enter; AI flags concern.
            BLOCK  = Clear invalid setup: reversal trap confirmed (gate + no direction confirmation), or COMPRESSION.
            AVOID  = Reserved for COMPRESSION regime only.

            Do NOT use BLOCK when:
              - isOppositeSideAfterStrongWinner == false
              - currentTradeAlignedWithRecentDirection == true
              - The only concern is high ADX without direction conflict

            ══════════════════════════════════════════════════════════
            Return ONLY valid JSON — no markdown, no text outside the JSON object:
            {
              "action": "ALLOW | CAUTION | BLOCK",
              "confidence": 0.0-1.0,
              "tradeQualityScore": 0.0-1.0,
              "riskLevel": "LOW | MEDIUM | HIGH",
              "reversalRisk": 0.0-1.0,
              "chopRisk": 0.0-1.0,
              "lateEntryRisk": 0.0-1.0,
              "overextensionRisk": 0.0-1.0,
              "reasonCodes": ["UPPERCASE_SNAKE_CASE"],
              "warningCodes": ["UPPERCASE_SNAKE_CASE"],
              "summary": "1-2 sentences on the PRIMARY risk or confirmation. State direction correctly (CE=bullish, PE=bearish)."
            }
            tradeQualityScore calibration: 0.00-0.30 = poor/avoid, 0.31-0.60 = risky/caution, 0.61-0.80 = acceptable, 0.81-1.00 = excellent. Must be consistent with action and riskLevel (e.g. CAUTION+HIGH should be 0.30-0.60, not 0.80+).
            Clamp all numeric scores to [0.0, 1.0]. Do not hallucinate data not present in the input.
            Return only valid JSON. Do not include markdown, explanation, or text outside the JSON object.
            """;

    // ── JSON Schema for Responses API structured output ──────────────────────

    private static final Map<String, Object> ADVISORY_SCHEMA = Map.ofEntries(
        Map.entry("type", "object"),
        Map.entry("additionalProperties", false),
        Map.entry("required", List.of(
                "action", "confidence", "tradeQualityScore", "riskLevel",
                "reversalRisk", "chopRisk", "lateEntryRisk", "overextensionRisk",
                "reasonCodes", "warningCodes", "summary")),
        Map.entry("properties", Map.ofEntries(
                Map.entry("action",           Map.of("type", "string", "enum",
                        List.of("ALLOW", "CAUTION", "AVOID", "BLOCK", "UNKNOWN"))),
                Map.entry("confidence",        Map.of("type", "number")),
                Map.entry("tradeQualityScore", Map.of("type", "number")),
                Map.entry("riskLevel",         Map.of("type", "string", "enum",
                        List.of("LOW", "MEDIUM", "HIGH", "UNKNOWN"))),
                Map.entry("reversalRisk",      Map.of("type", "number")),
                Map.entry("chopRisk",          Map.of("type", "number")),
                Map.entry("lateEntryRisk",     Map.of("type", "number")),
                Map.entry("overextensionRisk", Map.of("type", "number")),
                Map.entry("reasonCodes",       Map.of("type", "array",
                        "items", Map.of("type", "string"))),
                Map.entry("warningCodes",      Map.of("type", "array",
                        "items", Map.of("type", "string"))),
                Map.entry("summary",           Map.of("type", "string"))
        ))
    );

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
        String errorCategory = null;
        AdvisoryAiOutput output;

        String rawResponseJson = null;
        List<String> validationWarnings = List.of();
        boolean hasWarnings = false;

        if (openAiConfig.isEnabled()) {
            try {
                String effort = openAiConfig.getReasoningEffort();
                log.info("[{}] AI call: type=advisory model={} apiMode={} promptMode={} reasoningEffort={}",
                        requestId, openAiConfig.getModel(), openAiConfig.getApiMode(),
                        openAiConfig.getPromptMode(),
                        (effort != null && !effort.isBlank()) ? effort : "(none)");

                String rawContent = openAiClient.chat(selectAdvisoryPrompt(), requestJson,
                        "advisory_response", ADVISORY_SCHEMA);
                rawResponseJson = rawContent;  // raw extracted text from OpenAI, before our parsing

                output = parseAndValidateAdvisory(rawContent);
                log.info("[{}] Parsed advisory: action={} riskLevel={} confidence={} summaryLen={} reasonCodes={}",
                        requestId, output.action(), output.riskLevel(), output.confidence(),
                        output.summary() != null ? output.summary().length() : 0, output.reasonCodes());

                AdvisoryValidation validation = validateAdvisory(output, request, requestId);
                output = validation.output();  // apply normalization (e.g. BLOCK→AVOID)
                hasWarnings = validation.hasWarnings();
                validationWarnings = validation.warnings();

                log.info("[{}] OpenAI advisory: symbol={} action={} hasWarnings={}",
                        requestId, request.getSymbol(), output.action(), hasWarnings);
            } catch (OpenAiException e) {
                log.warn("[{}] OpenAI advisory failed — using fallback. error={}", requestId, e.getMessage());
                errorDetails = e.getMessage();
                errorCategory = e.getCategory() != null ? e.getCategory().name() : "UNKNOWN";
                output = fallbackEvaluator.advisory(request);
            }
        } else {
            log.debug("[{}] OpenAI disabled — using fallback advisory", requestId);
            errorCategory = "FALLBACK";
            output = fallbackEvaluator.advisory(request);
        }

        long latencyMs = System.currentTimeMillis() - start;
        AiSource source = (errorDetails == null && openAiConfig.isEnabled())
                ? AiSource.OPENAI
                : AiSource.FALLBACK;

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
        record.setRawResponseJson(rawResponseJson);
        record.setNormalized(hasWarnings);
        record.setNormalizationReasons(validationWarnings.isEmpty() ? null : validationWarnings);
        record.setErrorDetails(errorDetails);
        if (hasWarnings && errorCategory == null) errorCategory = "VALIDATION_ADJUSTED";
        record.setErrorCategory(errorCategory);
        record.setRequestId(requestId);
        record.setAiModel(openAiConfig.isEnabled() ? openAiConfig.getModel() : null);
        record.setAiApiMode(openAiConfig.isEnabled() ? openAiConfig.getApiMode() : null);
        record.setAiPromptMode(openAiConfig.isEnabled() ? openAiConfig.getPromptMode() : null);

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

    @Transactional(readOnly = true)
    public List<ExperimentSummaryResponse> listExperimentSummaries() {
        return advisoryRepository.findExperimentSummaries().stream()
                .map(row -> ExperimentSummaryResponse.builder()
                        .sessionId((String) row[0])
                        .aiModel((String) row[1])
                        .aiApiMode((String) row[2])
                        .aiPromptMode((String) row[3])
                        .advisoryCount((Long) row[4])
                        .latestCreatedAt(toInstant(row[5]))
                        .build())
                .toList();
    }

    private static java.time.Instant toInstant(Object o) {
        if (o instanceof java.time.Instant i) return i;
        if (o instanceof java.sql.Timestamp ts) return ts.toInstant();
        return null;
    }

    private String selectAdvisoryPrompt() {
        return switch (openAiConfig.getPromptMode().toLowerCase(Locale.ROOT)) {
            case "minimal" -> SYSTEM_PROMPT_MINIMAL;
            case "hybrid"  -> SYSTEM_PROMPT_HYBRID;
            default        -> SYSTEM_PROMPT;
        };
    }

    // ── Advisory direction validation ────────────────────────────────────────

    private record AdvisoryValidation(AdvisoryAiOutput output, boolean hasWarnings, List<String> warnings) {}

    private static final Set<String> UP_DIRECTION_KEYWORDS = Set.of(
            "moving up", "moved up", "nifty moving up", "upward", "up candle",
            "bullish", "bullish setup", "bullish movement", "bullish momentum",
            "bullish candle", "bullish trend", "upward movement", "upward trend",
            "recent upward", "rising", "upside", "up move",
            "profits from nifty moving up", "profiting from nifty moving up"
    );
    private static final Set<String> DOWN_DIRECTION_KEYWORDS = Set.of(
            "moving down", "moved down", "nifty moving down", "downward", "down candle",
            "bearish", "bearish setup", "bearish movement", "bearish momentum",
            "bearish candle", "bearish trend", "downward movement", "downward trend",
            "recent downward", "falling", "downside", "down move",
            "profits from nifty moving down", "profiting from nifty moving down"
    );
    private static final Set<String> SUPPORT_FRAMING_KEYWORDS = Set.of(
            "support", "align", "confirm", "favorable", "beneficial", "indicates strength"
    );

    private AdvisoryValidation validateAdvisory(AdvisoryAiOutput output, TradeCandidateRequest req, String requestId) {
        List<String> warnings = new ArrayList<>();
        AdvisoryAction action = output.action();

        // ── BLOCK → AVOID ─────────────────────────────────────────────────────
        if (action == AdvisoryAction.BLOCK) {
            String msg = "INVALID_ACTION_NORMALIZED: BLOCK normalized to AVOID";
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            action = AdvisoryAction.AVOID;
        }

        // Normalize for safe comparison — optType from any caller, reasonCodes from OpenAI
        String optType = req.getCurrentOptionType() != null
                ? req.getCurrentOptionType().toUpperCase(Locale.ROOT)
                : "";
        String summary = output.summary() != null ? output.summary().toLowerCase(Locale.ROOT) : "";
        List<String> reasonCodes = output.reasonCodes() != null
                ? output.reasonCodes().stream()
                        .filter(Objects::nonNull)
                        .map(s -> s.toUpperCase(Locale.ROOT))
                        .toList()
                : List.of();
        List<String> warningCodes = output.warningCodes() != null
                ? output.warningCodes().stream()
                        .filter(Objects::nonNull)
                        .collect(Collectors.toCollection(ArrayList::new))
                : new ArrayList<>();

        boolean hasUpKeyword   = UP_DIRECTION_KEYWORDS.stream().anyMatch(summary::contains);
        boolean hasDownKeyword = DOWN_DIRECTION_KEYWORDS.stream().anyMatch(summary::contains);
        boolean hasSupportWord = SUPPORT_FRAMING_KEYWORDS.stream().anyMatch(summary::contains);
        boolean directionContradictionFound = false;

        // ── PE direction contradiction ─────────────────────────────────────────
        if ("PE".equals(optType) && hasUpKeyword && hasSupportWord) {
            String msg = "DIRECTION_EXPLANATION_CONTRADICTION: PE is bearish (benefits from DOWN). "
                    + "Summary describes upward/bullish movement as supportive — this is incorrect.";
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            directionContradictionFound = true;
        }
        // ── CE direction contradiction ─────────────────────────────────────────
        if ("CE".equals(optType) && hasDownKeyword && hasSupportWord) {
            String msg = "DIRECTION_EXPLANATION_CONTRADICTION: CE is bullish (benefits from UP). "
                    + "Summary describes downward/bearish movement as supportive — this is incorrect.";
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            directionContradictionFound = true;
        }
        // ── Contradictory reasonCodes ──────────────────────────────────────────
        if ("PE".equals(optType) && reasonCodes.contains("BULLISH_STRUCTURE")) {
            String msg = "DIRECTION_EXPLANATION_CONTRADICTION: PE is bearish but BULLISH_STRUCTURE appears in reasonCodes.";
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            directionContradictionFound = true;
        }
        if ("CE".equals(optType) && reasonCodes.contains("BEARISH_STRUCTURE")) {
            String msg = "DIRECTION_EXPLANATION_CONTRADICTION: CE is bullish but BEARISH_STRUCTURE appears in reasonCodes.";
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            directionContradictionFound = true;
        }

        // ── Apply corrections when direction contradiction found ────────────────
        double normalizedConfidence        = output.confidence();
        double normalizedTradeQualityScore = output.tradeQualityScore();

        if (directionContradictionFound) {
            if (action == AdvisoryAction.ALLOW) {
                warnings.add("ACTION_ESCALATED: ALLOW→CAUTION due to DIRECTION_EXPLANATION_CONTRADICTION");
                action = AdvisoryAction.CAUTION;
            }
            if (normalizedConfidence > 0.60) {
                warnings.add("CONFIDENCE_CAPPED: " + normalizedConfidence + "→0.60 due to DIRECTION_EXPLANATION_CONTRADICTION");
                normalizedConfidence = 0.60;
            }
            if (normalizedTradeQualityScore > 0.50) {
                warnings.add("TRADE_QUALITY_SCORE_CAPPED: " + normalizedTradeQualityScore + "→0.50 due to DIRECTION_EXPLANATION_CONTRADICTION");
                normalizedTradeQualityScore = 0.50;
            }
            if (!warningCodes.contains("AI_DIRECTION_REASONING_INVALID")) {
                warningCodes.add("AI_DIRECTION_REASONING_INVALID");
            }
        }

        // ── tradeQualityScore calibration caps ────────────────────────────────
        double cap;
        if (action == AdvisoryAction.AVOID) {
            cap = 0.35;
        } else if (action == AdvisoryAction.CAUTION && output.riskLevel() == RiskLevel.HIGH) {
            cap = 0.55;
        } else if (action == AdvisoryAction.CAUTION) {
            cap = 0.75;
        } else if (output.riskLevel() == RiskLevel.HIGH) {
            cap = 0.60;
        } else {
            cap = 1.0;
        }
        if (normalizedTradeQualityScore > cap) {
            warnings.add("TRADE_QUALITY_SCORE_CAPPED: " + normalizedTradeQualityScore + "→" + cap
                    + " (action=" + action + " riskLevel=" + output.riskLevel() + ")");
            log.info("[{}] tradeQualityScore capped: {}→{} action={} riskLevel={}",
                    requestId, normalizedTradeQualityScore, cap, action, output.riskLevel());
            normalizedTradeQualityScore = cap;
        }

        // ── Build normalized output ────────────────────────────────────────────
        boolean anyChange = action != output.action()
                || normalizedConfidence != output.confidence()
                || normalizedTradeQualityScore != output.tradeQualityScore()
                || !warningCodes.equals(output.warningCodes());

        AdvisoryAiOutput normalizedOutput = anyChange
                ? new AdvisoryAiOutput(action, normalizedConfidence, normalizedTradeQualityScore,
                        output.riskLevel(), output.reversalRisk(), output.chopRisk(),
                        output.lateEntryRisk(), output.overextensionRisk(),
                        output.reasonCodes(), List.copyOf(warningCodes), output.summary())
                : output;

        return new AdvisoryValidation(normalizedOutput, !warnings.isEmpty(), List.copyOf(warnings));
    }

    // ── OpenAI response parsing + validation ─────────────────────────────────

    private AdvisoryAiOutput parseAndValidateAdvisory(String content) {
        try {
            Map<?, ?> raw = objectMapper.readValue(content, Map.class);
            log.info("Advisory JSON keys={} action='{}' confidence={} summaryLen={}",
                    raw.keySet(), raw.get("action"), raw.get("confidence"),
                    raw.get("summary") instanceof String s ? s.length() : "null/missing");

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
            throw new OpenAiException("Advisory JSON parse failed: " + e.getMessage(), e, OpenAiClient.OpenAiException.Category.PARSE_FAILURE);
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
