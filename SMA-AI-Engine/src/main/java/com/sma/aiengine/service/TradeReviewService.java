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

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class TradeReviewService {

    // ── Prompt modes ─────────────────────────────────────────────────────────

    private static final String SYSTEM_PROMPT_MINIMAL = """
            You are a trading analyst reviewing a completed NIFTY options trade.

            In this system:
            - CE is a call option and generally benefits when NIFTY moves up.
            - PE is a put option and generally benefits when NIFTY moves down.
            - side = LONG_OPTION means the option is bought.

            Analyze the provided payload and judge the trade quality, whether it was avoidable, what worked, what failed, and whether a useful rule can be learned.

            Use the available data: P&L, P&L %, entry/exit reason, MFE/MAE, recent candles, option type, strategy scores, regime, ADX, ATR, previous trade context, filters, and trade context.

            confidence = your certainty in this review classification (NOT trade-taking confidence):
              clear GOOD trade: 0.70–0.90 | clear BAD avoidable mistake: 0.75–0.95 | NEUTRAL/mixed/debatable: 0.45–0.70 | UNKNOWN/insufficient data: 0.00–0.40

            Return only valid JSON using exactly these keys — no other keys allowed:
            {"quality":"GOOD|BAD|NEUTRAL|UNKNOWN","avoidable":true|false,"mistakeType":"NONE|REVERSAL_TRAP|LATE_ENTRY|BAD_EXIT|WEAK_CONFIRMATION|OVEREXTENSION|CHOP_ENTRY|UNKNOWN","confidence":0.0,"summary":"","whatWorked":[],"whatFailed":[],"suggestedRule":"","reasonCodes":[],"warningCodes":[]}
            """;

    private static final String SYSTEM_PROMPT_HYBRID = """
            You are a trading analyst reviewing a completed NIFTY options trade.

            In this system:
            - CE is a call option and generally benefits when NIFTY moves up.
            - PE is a put option and generally benefits when NIFTY moves down.
            - side = LONG_OPTION means the option is bought.

            Think like a trade journal reviewer. Judge whether the trade was good, bad, or neutral using the actual outcome and the information available around entry. Identify if the mistake was avoidable, whether there was a reversal trap, weak confirmation, late entry, chop entry, bad exit, or no clear mistake.

            Do not mechanically follow one field. Weigh the full context.

            confidence = your certainty in this review classification (NOT trade-taking confidence):
              clear GOOD trade: 0.70–0.90 | clear BAD avoidable mistake: 0.75–0.95 | NEUTRAL/mixed/debatable: 0.45–0.70 | UNKNOWN/insufficient data: 0.00–0.40

            Return only valid JSON using exactly these keys — no other keys allowed:
            {"quality":"GOOD|BAD|NEUTRAL|UNKNOWN","avoidable":true|false,"mistakeType":"NONE|REVERSAL_TRAP|LATE_ENTRY|BAD_EXIT|WEAK_CONFIRMATION|OVEREXTENSION|CHOP_ENTRY|UNKNOWN","confidence":0.0,"summary":"","whatWorked":[],"whatFailed":[],"suggestedRule":"","reasonCodes":[],"warningCodes":[]}
            """;

    private static final String SYSTEM_PROMPT = """
            You are a trade quality reviewer for Indian NIFTY options (CE and PE).
            This is a POST-TRADE review. Analyze the completed trade and return ONLY valid JSON.

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
            SECTION 0B — P&L CONSISTENCY RULES (must not be violated)
            ══════════════════════════════════════════════════════════
            The payload field `tradeOutcome` is the ground truth: PROFIT, LOSS, or BREAKEVEN.
            The payload field `pnlPct` is the realized P&L percentage.

            RULE 1 — Never describe a profitable trade as a loss:
              If tradeOutcome = PROFIT (pnlPct > 0): your summary MUST NOT contain "loss", "lost", or "losing".
              If tradeOutcome = PROFIT and exitReason = PROFIT_LOCK_HIT: mention that the profit lock was hit.

            RULE 2 — Never describe a losing trade as a profit:
              If tradeOutcome = LOSS (pnlPct < 0): your summary MUST NOT contain "profit", "gained", or "winner".

            RULE 3 — Quality must match outcome:
              If tradeOutcome = PROFIT: quality should typically be GOOD or NEUTRAL (not BAD unless there's a specific reason).
              If tradeOutcome = LOSS and mistakeType = NONE: quality should be NEUTRAL (not BAD).

            ══════════════════════════════════════════════════════════
            SECTION 1 — IMMUTABLE DIRECTION FACTS
            ══════════════════════════════════════════════════════════
            CE (Call) = BULLISH trade. Profits when NIFTY moves UP. Describe CE winners as bullish setups.
            PE (Put)  = BEARISH trade. Profits when NIFTY moves DOWN. Describe PE winners as bearish setups.
            Both CE and PE are BUY (long) positions. side = LONG_OPTION for all.
            NEVER describe a PE trade as bullish. NEVER describe a CE trade as bearish.
            A PE that won did so because NIFTY moved DOWN (bearish movement, favorable for PE).
            A CE that won did so because NIFTY moved UP (bullish movement, favorable for CE).

            ══════════════════════════════════════════════════════════
            SECTION 2 — ROOT CAUSE RULE (do not judge by exitReason alone)
            ══════════════════════════════════════════════════════════
            HARD_STOP_LOSS is a SYMPTOM, not the root cause.
            Identify WHY the trade failed, not HOW it exited.

            mistakeType options:
              NONE              = No mistake. Trade executed well.
              BAD_EXIT          = Entry was valid (tradeHadFollowThrough=true) but exit was poorly timed.
              REVERSAL_TRAP     = Entered opposite direction immediately after a strong winner before structure reversed.
              LATE_ENTRY        = Entered after the move was already largely complete.
              WEAK_CONFIRMATION = Setup lacked sufficient confirmation signals; entry was premature or poorly supported.
              OVEREXTENSION     = Entered after the move was already overextended; reversion risk was high.
              CHOP_ENTRY        = Entered during a choppy/ranging market without clear direction.
              UNKNOWN           = Insufficient data.

            ══════════════════════════════════════════════════════════
            SECTION 3 — MFE/MAE CLASSIFICATION RULES
            ══════════════════════════════════════════════════════════
            Apply these before anything else when pnlPct < 0:

            IF mfeQuality = VERY_LOW AND maeSeverity = HIGH:
              → Trade went immediately against entry direction. Never worked.
              → mistakeType = REVERSAL_TRAP (if reversal conditions below apply) else BAD_ENTRY
              → avoidable = true. Do NOT set BAD_EXIT.
            IF mfeQuality = VERY_LOW AND pnlPct < 0:
              → exitReason is irrelevant. Trade never moved favorably. Focus on entry quality.
            IF lossHappenedQuickly = true:
              → Trade was wrong from the start. Evaluate entry conditions, not exit.
            IF tradeHadFollowThrough = true AND pnlPct < 0:
              → Trade had a valid start but gave back gains. Consider BAD_EXIT or MARKET_NOISE.
            DO NOT recommend trailing stops when mfeQuality = VERY_LOW or LOW.
              Trailing stops only help after favorable movement. They cannot fix a bad entry.

            ══════════════════════════════════════════════════════════
            SECTION 4 — REVERSAL TRAP DETECTION (boolean-gated)
            ══════════════════════════════════════════════════════════
            Apply REVERSAL_TRAP only if ALL are true from payload fields:
              (a) isOppositeSideAfterStrongWinner == true  [use this boolean directly]
              (b) previousTradeWasStrongWinner == true  OR  previousTradePnlPct >= 5.0
              (c) minutesSincePreviousExit <= 1  OR  sameCandleFlip == true
              (d) pnlPct < 0

            For PE after strong CE winner: if dominantRecentDirection was UP, bearish reversal was not confirmed.
            For CE after strong PE winner: if dominantRecentDirection was DOWN, bullish reversal was not confirmed.
            In REVERSAL_TRAP cases: suggestedRule must focus on AVOIDING the setup, not fixing the exit.
            Example: "Do not enter PE within 1 candle of a CE winner > 5% unless dominantRecentDirection = DOWN."

            If isOppositeSideAfterStrongWinner == false, do NOT apply reversal trap logic regardless of P&L.

            ══════════════════════════════════════════════════════════
            SECTION 5 — QUALITY SCORING
            ══════════════════════════════════════════════════════════
            GOOD    = Trade followed through, direction was valid, outcome was positive.
            BAD     = Trade lost due to bad entry, reversal trap, or counter-trend entry. avoidable = true.
            NEUTRAL = Trade lost but had a valid setup; loss due to market noise or reasonable stop.

            Return ONLY valid JSON using exactly these keys — no other keys allowed:
            {
              "quality": "GOOD | BAD | NEUTRAL | UNKNOWN",
              "avoidable": true | false,
              "mistakeType": "NONE | REVERSAL_TRAP | LATE_ENTRY | BAD_EXIT | WEAK_CONFIRMATION | OVEREXTENSION | CHOP_ENTRY | UNKNOWN",
              "confidence": 0.0-1.0  (certainty in this review — clear GOOD: 0.70-0.90, clear BAD avoidable: 0.75-0.95, NEUTRAL/mixed: 0.45-0.70, UNKNOWN/insufficient: 0.00-0.40),
              "summary": "1-2 sentences on root cause. State direction correctly (CE=bullish, PE=bearish).",
              "whatWorked": ["factor"],
              "whatFailed": ["factor"],
              "suggestedRule": "specific actionable rule — for reversal traps, focus on avoiding the setup",
              "reasonCodes": ["UPPERCASE_SNAKE_CASE"],
              "warningCodes": ["UPPERCASE_SNAKE_CASE"]
            }
            whatWorked/whatFailed: 1–4 key factors each.
            suggestedRule: specific and actionable, or empty string if no suggestion.
            Return only valid JSON. Do not include markdown, explanation, or text outside the JSON object.
            """;

    // ── JSON Schema for Responses API structured output ──────────────────────

    private static final Map<String, Object> REVIEW_SCHEMA = Map.ofEntries(
        Map.entry("type", "object"),
        Map.entry("additionalProperties", false),
        Map.entry("required", List.of(
                "quality", "avoidable", "mistakeType", "confidence",
                "summary", "whatWorked", "whatFailed", "suggestedRule",
                "reasonCodes", "warningCodes")),
        Map.entry("properties", Map.ofEntries(
                Map.entry("quality",       Map.of("type", "string", "enum",
                        List.of("GOOD", "BAD", "NEUTRAL", "UNKNOWN"))),
                Map.entry("avoidable",     Map.of("type", "boolean")),
                Map.entry("mistakeType",   Map.of("type", "string", "enum",
                        List.of("NONE", "REVERSAL_TRAP", "LATE_ENTRY", "BAD_EXIT",
                                "WEAK_CONFIRMATION", "OVEREXTENSION", "CHOP_ENTRY", "UNKNOWN"))),
                Map.entry("confidence",    Map.of("type", "number")),
                Map.entry("summary",       Map.of("type", "string")),
                Map.entry("whatWorked",    Map.of("type", "array",
                        "items", Map.of("type", "string"))),
                Map.entry("whatFailed",    Map.of("type", "array",
                        "items", Map.of("type", "string"))),
                Map.entry("suggestedRule", Map.of("type", "string")),
                Map.entry("reasonCodes",   Map.of("type", "array",
                        "items", Map.of("type", "string"))),
                Map.entry("warningCodes",  Map.of("type", "array",
                        "items", Map.of("type", "string")))
        ))
    );

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
        String errorCategory = null;
        TradeReviewAiOutput output;

        String rawResponseJson = null;
        List<String> normalizationReasons = List.of();
        boolean wasNormalized = false;

        if (openAiConfig.isEnabled()) {
            try {
                String effort = openAiConfig.getReasoningEffort();
                log.info("[{}] AI call: type=review model={} apiMode={} promptMode={} reasoningEffort={}",
                        requestId, openAiConfig.getModel(), openAiConfig.getApiMode(),
                        openAiConfig.getPromptMode(),
                        (effort != null && !effort.isBlank()) ? effort : "(none)");

                String rawContent = openAiClient.chat(selectReviewPrompt(), requestJson,
                        "trade_review_response", REVIEW_SCHEMA);
                rawResponseJson = rawContent;  // raw extracted text from OpenAI, before our parsing

                TradeReviewAiOutput rawOutput = parseAndValidateReview(rawContent);
                log.info("[{}] Parsed review: quality={} mistakeType={} avoidable={} confidence={} summaryLen={} whatFailed={}",
                        requestId, rawOutput.quality(), rawOutput.mistakeType(), rawOutput.avoidable(),
                        rawOutput.confidence(),
                        rawOutput.summary() != null ? rawOutput.summary().length() : 0,
                        rawOutput.whatFailed());

                NormalizedReview norm = normalizeReview(rawOutput, request, requestId);
                output = norm.output();
                normalizationReasons = norm.reasons();
                wasNormalized = norm.wasNormalized();

                log.info("[{}] OpenAI review: tradeId={} quality={} normalized={}",
                        requestId, request.getTradeId(), output.quality(), wasNormalized);
            } catch (OpenAiException e) {
                log.warn("[{}] OpenAI review failed — using fallback. error={}", requestId, e.getMessage());
                errorDetails = e.getMessage();
                errorCategory = e.getCategory() != null ? e.getCategory().name() : "UNKNOWN";
                output = fallbackEvaluator.review(request);
            }
        } else {
            log.debug("[{}] OpenAI disabled — using fallback review", requestId);
            errorCategory = "FALLBACK";
            output = fallbackEvaluator.review(request);
        }

        long latencyMs = System.currentTimeMillis() - start;
        AiSource source = (errorDetails == null && openAiConfig.isEnabled())
                ? AiSource.OPENAI
                : AiSource.FALLBACK;

        String responseJson = safeSerialize(output);

        // Upsert: re-running the same tick session replaces the previous review for this trade
        TradeReviewRecord record = tradeReviewRepository
                .findBySessionIdAndTradeId(request.getSessionId(), request.getTradeId())
                .orElseGet(() -> TradeReviewRecord.builder()
                        .tradeId(request.getTradeId())
                        .sessionId(request.getSessionId())
                        .symbol(request.getSymbol())
                        .side(request.getSide())
                        .regime(request.getRegime())
                        .entryTime(parseToInstant(request.getEntryTime()))
                        .exitTime(parseToInstant(request.getExitTime()))
                        .pnl(request.getPnl())
                        .pnlPct(request.getPnlPct())
                        .exitReason(request.getExitReason())
                        .build());

        record.setQuality(output.quality());
        record.setAvoidable(output.avoidable());
        record.setMistakeType(output.mistakeType());
        record.setConfidence(output.confidence());
        record.setSummary(output.summary());
        record.setWhatWorked(output.whatWorked());
        record.setWhatFailed(output.whatFailed());
        record.setSuggestedRule(output.suggestedRule());
        record.setReasonCodes(output.reasonCodes());
        record.setWarningCodes(output.warningCodes());
        record.setSource(source);
        record.setLatencyMs(latencyMs);
        record.setRequestJson(requestJson);
        record.setResponseJson(responseJson);
        record.setRawResponseJson(rawResponseJson);
        record.setNormalized(wasNormalized);
        record.setNormalizationReasons(normalizationReasons.isEmpty() ? null : normalizationReasons);
        record.setErrorDetails(errorDetails);
        if (wasNormalized && errorCategory == null) errorCategory = "VALIDATION_ADJUSTED";
        record.setErrorCategory(errorCategory);
        record.setRequestId(requestId);
        record.setAiModel(openAiConfig.isEnabled() ? openAiConfig.getModel() : null);
        record.setAiApiMode(openAiConfig.isEnabled() ? openAiConfig.getApiMode() : null);
        record.setAiPromptMode(openAiConfig.isEnabled() ? openAiConfig.getPromptMode() : null);

        record = tradeReviewRepository.save(record);

        TradeReviewResponse response = TradeReviewResponse.from(record);

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

    private String selectReviewPrompt() {
        return switch (openAiConfig.getPromptMode().toLowerCase(Locale.ROOT)) {
            case "minimal" -> SYSTEM_PROMPT_MINIMAL;
            case "hybrid"  -> SYSTEM_PROMPT_HYBRID;
            default        -> SYSTEM_PROMPT;
        };
    }

    // ── Normalization ─────────────────────────────────────────────────────────

    private record NormalizedReview(TradeReviewAiOutput output, boolean wasNormalized, List<String> reasons) {}

    private static final Set<String> GENERIC_WHAT_FAILED_FRAGMENTS = Set.of(
            "previous trade did not perform",
            "no indication of downside move",
            "no indication of upside move",
            "minor adverse excursion before profit",
            "no clear indication",
            "no adverse excursion",
            "no significant adverse excursion"
    );

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
    private static final Set<String> FAVORABLE_OUTCOME_KEYWORDS = Set.of(
            "profit", "profited", "profiting", "favorable", "benefit", "benefiting",
            "successful", "worked", "aligned", "supports",
            "resulted in a profit", "resulted in profit", "capturing", "captured",
            "benefited", "aligned with", "in profit"
    );

    private static final Set<String> PREVIOUS_CONTEXT_PHRASES = Set.of(
            "previous trade", "previous winner", "prior trade", "prior winner",
            "strong winner", "strong bullish winner", "strong bearish winner",
            "after a strong bullish", "after a bullish", "after a bearish",
            "entered after", "previous ce", "previous pe", "prior ce", "prior pe"
    );

    private static final Set<String> NEGATION_PHRASES = Set.of(
            "unfavorable", "not favorable", "against the position",
            "opposing trade direction", "moved against", "failed to confirm"
    );

    // Sentences that mention an adverse outcome should NOT be flagged as direction contradictions,
    // even if they contain a direction keyword and a favorable-sounding word.
    // e.g. "market resumed upward, hitting the stop and producing a -6% loss" is correct PE analysis.
    private static final Set<String> ADVERSE_OUTCOME_KEYWORDS = Set.of(
            "loss", "lost", "losing", "stopped out", "hit the stop", "hitting the stop",
            "adverse", "failed", "against the", "hurt the", "causing a loss",
            "resulted in a loss", "producing a loss", "cost the trade", "causing the trade to fail"
    );

    private NormalizedReview normalizeReview(TradeReviewAiOutput raw, CompletedTradeRequest req, String requestId) {
        List<String> reasons = new ArrayList<>();

        TradeQuality    quality     = raw.quality();
        boolean         avoidable   = raw.avoidable();
        MistakeType     mistakeType = raw.mistakeType();
        List<String>    reasonCodes  = new ArrayList<>(raw.reasonCodes());
        List<String>    warningCodes = new ArrayList<>(raw.warningCodes());
        List<String>    whatFailed   = new ArrayList<>(raw.whatFailed());

        Double  pnlPct     = req.getPnlPct();
        String  exitReason = req.getExitReason();
        String  optType    = req.getCurrentOptionType();
        // Fallback: derive option type from symbol when currentOptionType is absent
        if (optType == null || optType.isBlank()) {
            String sym = req.getSymbol();
            if (sym != null) {
                String symUpper = sym.toUpperCase(Locale.ROOT);
                if (symUpper.endsWith("PE")) optType = "PE";
                else if (symUpper.endsWith("CE")) optType = "CE";
            }
        }
        String  summary    = raw.summary() != null ? raw.summary().toLowerCase(Locale.ROOT) : "";

        // ── Rule A1: REVERSAL_TRAP forces BAD + avoidable ─────────────────
        if (mistakeType == MistakeType.REVERSAL_TRAP) {
            if (quality != TradeQuality.BAD) {
                reasons.add("REVERSAL_TRAP_REQUIRES_BAD: quality was " + quality + ", forced to BAD");
                quality = TradeQuality.BAD;
            }
            if (!avoidable) {
                reasons.add("REVERSAL_TRAP_REQUIRES_AVOIDABLE: avoidable forced to true");
                avoidable = true;
            }
        }

        // ── Rule A2: loss + actionable mistake → BAD + avoidable ──────────
        if (pnlPct != null && pnlPct < 0
                && mistakeType != MistakeType.NONE
                && mistakeType != MistakeType.MARKET_NOISE
                && mistakeType != MistakeType.UNKNOWN) {
            if (quality != TradeQuality.BAD) {
                reasons.add("LOSS_WITH_MISTAKE_REQUIRES_BAD: pnlPct=" + pnlPct
                        + " mistakeType=" + mistakeType + ", quality was " + quality + ", forced to BAD");
                quality = TradeQuality.BAD;
            }
            if (!avoidable) {
                reasons.add("LOSS_WITH_MISTAKE_REQUIRES_AVOIDABLE: pnlPct=" + pnlPct
                        + " mistakeType=" + mistakeType + ", avoidable forced to true");
                avoidable = true;
            }
        }

        // ── Rule A3: loss cannot be GOOD ──────────────────────────────────
        if (pnlPct != null && pnlPct < 0 && quality == TradeQuality.GOOD) {
            TradeQuality downgraded = (mistakeType == MistakeType.NONE || mistakeType == MistakeType.MARKET_NOISE)
                    ? TradeQuality.NEUTRAL : TradeQuality.BAD;
            reasons.add("LOSS_CANNOT_BE_GOOD: pnlPct=" + pnlPct + ", quality downgraded GOOD→" + downgraded);
            quality = downgraded;
        }

        // ── Rule A4: profit cannot be BAD when no mistake ─────────────────
        if (pnlPct != null && pnlPct > 0 && quality == TradeQuality.BAD && mistakeType == MistakeType.NONE) {
            reasons.add("PROFIT_CANNOT_BE_BAD_WITHOUT_MISTAKE: pnlPct=" + pnlPct + ", quality upgraded BAD→GOOD");
            quality = TradeQuality.GOOD;
            avoidable = false;
        }

        // ── Rule B: exit reason consistency ───────────────────────────────
        if (!"PROFIT_LOCK_HIT".equals(exitReason) && reasonCodes.remove("PROFIT_LOCK_HIT")) {
            reasons.add("EXIT_REASON_MISMATCH: removed PROFIT_LOCK_HIT from reasonCodes (exitReason=" + exitReason + ")");
        }
        if (!"HARD_STOP_LOSS".equals(exitReason) && warningCodes.remove("HARD_STOP_LOSS")) {
            reasons.add("EXIT_REASON_MISMATCH: removed HARD_STOP_LOSS from warningCodes (exitReason=" + exitReason + ")");
        }

        // ── Rule C: option type wording validation (log only) ─────────────
        if ("PE".equals(optType)) {
            if (summary.contains("bullish trade on a ce") || summary.contains("bullish ce")
                    || summary.contains("ce trade") || summary.contains("call option")) {
                log.warn("[{}] VALIDATION_WARNING: currentOptionType=PE but summary contains CE/call language: {}",
                        requestId, raw.summary());
            }
        } else if ("CE".equals(optType)) {
            if (summary.contains("bearish pe") || summary.contains("pe trade")
                    || summary.contains("put option")) {
                log.warn("[{}] VALIDATION_WARNING: currentOptionType=CE but summary contains PE/put language: {}",
                        requestId, raw.summary());
            }
        }
        if (summary.contains("bullish pe") || summary.contains("bullish put")) {
            log.warn("[{}] VALIDATION_WARNING: PE described as bullish — summary: {}", requestId, raw.summary());
        }
        if (summary.contains("bearish ce") || summary.contains("bearish call")) {
            log.warn("[{}] VALIDATION_WARNING: CE described as bearish — summary: {}", requestId, raw.summary());
        }
        if (pnlPct != null && pnlPct > 0 && (summary.contains(" loss") || summary.contains("lost"))) {
            log.warn("[{}] VALIDATION_WARNING: trade was PROFIT (pnlPct={}) but summary contains loss language: {}",
                    requestId, pnlPct, raw.summary());
        }

        // ── Rule E: direction contradiction validation (per-sentence) ────────
        boolean directionContradictionFound = false;

        if ("PE".equals(optType) && hasDirectionContradictionInSentences(summary, UP_DIRECTION_KEYWORDS)) {
            String msg = "DIRECTION_EXPLANATION_CONTRADICTION: PE is bearish (profits from NIFTY DOWN). "
                       + "Summary describes upward/bullish movement as favorable/profitable — this is factually incorrect.";
            reasons.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            directionContradictionFound = true;
        }
        if ("CE".equals(optType) && hasDirectionContradictionInSentences(summary, DOWN_DIRECTION_KEYWORDS)) {
            String msg = "DIRECTION_EXPLANATION_CONTRADICTION: CE is bullish (profits from NIFTY UP). "
                       + "Summary describes downward/bearish movement as favorable/profitable — this is factually incorrect.";
            reasons.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            directionContradictionFound = true;
        }
        // Contradictory reasonCodes
        if ("PE".equals(optType)) {
            List<String> bullishCodes = reasonCodes.stream()
                    .filter(c -> c.startsWith("BULLISH_"))
                    .toList();
            if (!bullishCodes.isEmpty()) {
                String msg = "DIRECTION_EXPLANATION_CONTRADICTION: PE is bearish but reasonCodes contain bullish codes: " + bullishCodes;
                reasons.add(msg);
                log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
                directionContradictionFound = true;
            }
        }
        if ("CE".equals(optType)) {
            List<String> bearishCodes = reasonCodes.stream()
                    .filter(c -> c.startsWith("BEARISH_"))
                    .toList();
            if (!bearishCodes.isEmpty()) {
                String msg = "DIRECTION_EXPLANATION_CONTRADICTION: CE is bullish but reasonCodes contain bearish codes: " + bearishCodes;
                reasons.add(msg);
                log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
                directionContradictionFound = true;
            }
        }
        if (directionContradictionFound && !warningCodes.contains("AI_DIRECTION_REASONING_INVALID")) {
            warningCodes.add("AI_DIRECTION_REASONING_INVALID");
        }

        // ── Rule D: clean up irrelevant whatFailed for clean good trades ───
        if (pnlPct != null && pnlPct > 0 && quality == TradeQuality.GOOD && !avoidable
                && mistakeType == MistakeType.NONE && !whatFailed.isEmpty()) {
            List<String> kept = whatFailed.stream()
                    .filter(s -> !isGenericWhatFailed(s))
                    .toList();
            if (kept.size() < whatFailed.size()) {
                reasons.add("GOOD_TRADE_CLEANUP: removed " + (whatFailed.size() - kept.size())
                        + " generic whatFailed item(s)");
                whatFailed = kept;
            }
        }

        // ── Confidence floor guardrails ───────────────────────────────────────
        double confidence = raw.confidence();

        // Clear GOOD: strong profit, minimal adverse excursion, no mistake
        if (quality == TradeQuality.GOOD && !avoidable && mistakeType == MistakeType.NONE
                && pnlPct != null && pnlPct > 3.0
                && (req.getMaxAdverseExcursionPct() == null || req.getMaxAdverseExcursionPct() > -3.0)
                && confidence < 0.65) {
            reasons.add("CONFIDENCE_FLOOR: GOOD clear trade (pnlPct=" + pnlPct + ") → floor 0.65");
            log.info("[{}] Confidence floored: {}→0.65 (GOOD trade pnlPct={} lowMAE)", requestId, confidence, pnlPct);
            confidence = 0.65;
        }

        // Clear BAD: avoidable, significant loss
        if (quality == TradeQuality.BAD && avoidable && pnlPct != null && pnlPct < -3.0
                && confidence < 0.70) {
            reasons.add("CONFIDENCE_FLOOR: BAD avoidable trade (pnlPct=" + pnlPct + ") → floor 0.70");
            log.info("[{}] Confidence floored: {}→0.70 (BAD avoidable pnlPct={})", requestId, confidence, pnlPct);
            confidence = 0.70;
        }

        // Confirmed reversal trap: boolean flags leave no ambiguity
        if (mistakeType == MistakeType.REVERSAL_TRAP
                && Boolean.TRUE.equals(req.getPreviousTradeWasStrongWinner())
                && Boolean.TRUE.equals(req.getIsOppositeSideAfterStrongWinner())
                && confidence < 0.75) {
            reasons.add("CONFIDENCE_FLOOR: REVERSAL_TRAP confirmed by boolean flags → floor 0.75");
            log.info("[{}] Confidence floored: {}→0.75 (REVERSAL_TRAP confirmed)", requestId, confidence);
            confidence = 0.75;
        }

        if (!reasons.isEmpty()) {
            log.info("[{}] Normalization applied for tradeId={}: {}", requestId, req.getTradeId(), reasons);
        }

        TradeReviewAiOutput normalized = new TradeReviewAiOutput(
                quality, avoidable, mistakeType, confidence,
                raw.summary(), raw.whatWorked(), whatFailed,
                raw.suggestedRule(), reasonCodes, warningCodes);

        return new NormalizedReview(normalized, !reasons.isEmpty(), List.copyOf(reasons));
    }

    private boolean hasDirectionContradictionInSentences(String summary, Set<String> directionKeywords) {
        String[] sentences = summary.split("[.!?]+\\s*");
        for (String s : sentences) {
            if (s.isBlank()) continue;
            boolean hasDir     = directionKeywords.stream().anyMatch(s::contains);
            boolean hasFav     = FAVORABLE_OUTCOME_KEYWORDS.stream().anyMatch(s::contains);
            boolean hasPrev    = PREVIOUS_CONTEXT_PHRASES.stream().anyMatch(s::contains);
            boolean hasNeg     = NEGATION_PHRASES.stream().anyMatch(s::contains);
            // Only flag if the sentence does NOT describe the direction as causing a loss.
            // e.g. "market resumed upward, hitting the stop at -6% loss" is correct PE analysis.
            boolean hasAdverse = ADVERSE_OUTCOME_KEYWORDS.stream().anyMatch(s::contains);
            if (hasDir && hasFav && !hasPrev && !hasNeg && !hasAdverse) return true;
        }
        return false;
    }

    private boolean isGenericWhatFailed(String item) {
        if (item == null) return false;
        String lower = item.toLowerCase();
        return GENERIC_WHAT_FAILED_FRAGMENTS.stream().anyMatch(lower::contains);
    }

    // ── OpenAI response parsing + validation ─────────────────────────────────

    private TradeReviewAiOutput parseAndValidateReview(String content) {
        try {
            Map<?, ?> raw = objectMapper.readValue(content, Map.class);
            log.info("Review JSON keys={} quality='{}' mistakeType='{}' confidence={} summaryLen={}",
                    raw.keySet(), raw.get("quality"), raw.get("mistakeType"), raw.get("confidence"),
                    raw.get("summary") instanceof String s ? s.length() : "null/missing");

            List<String> aliasesUsed = new ArrayList<>();

            // quality — primary key, then alias fallbacks
            Object qualityRaw = raw.get("quality");
            String qualityKey = "quality";
            if (qualityRaw == null || (qualityRaw instanceof String qs && qs.isBlank())) {
                for (String alt : List.of("verdict", "tradeRating", "judgement", "rating", "grade")) {
                    if (raw.containsKey(alt)) { qualityRaw = raw.get(alt); qualityKey = alt; break; }
                }
            }
            TradeQuality quality = resolveQuality(qualityRaw);
            if (!"quality".equals(qualityKey)) aliasesUsed.add("quality←" + qualityKey);

            // mistakeType — primary key, then alias fallbacks
            Object mistakeRaw = raw.get("mistakeType");
            String mistakeKey = "mistakeType";
            if (mistakeRaw == null || (mistakeRaw instanceof String ms && ms.isBlank())) {
                for (String alt : List.of("mistake", "primaryIssue", "mistakeCategory", "mistakes")) {
                    if (raw.containsKey(alt)) { mistakeRaw = raw.get(alt); mistakeKey = alt; break; }
                }
            }
            MistakeType mistakeType = resolveMistakeType(mistakeRaw);
            if (!"mistakeType".equals(mistakeKey)) aliasesUsed.add("mistakeType←" + mistakeKey);

            // avoidable — primary key, then "avoidability" string fallback
            boolean avoidable = resolveAvoidable(raw, aliasesUsed);

            // summary — primary key, then alias fallbacks
            Object summaryRaw = raw.get("summary");
            String summaryKey = "summary";
            if (summaryRaw == null || (summaryRaw instanceof String ss && ss.isBlank())) {
                for (String alt : List.of("notes", "commentary", "comment", "rationale", "remarks")) {
                    if (raw.containsKey(alt)) { summaryRaw = raw.get(alt); summaryKey = alt; break; }
                }
            }
            String summary = summaryRaw instanceof String s ? s : "";
            if (!"summary".equals(summaryKey)) aliasesUsed.add("summary←" + summaryKey);

            if (!aliasesUsed.isEmpty()) {
                log.warn("Review alias fallback used — schema enforcement may have failed. aliases={} keys={}",
                        aliasesUsed, raw.keySet());
            }

            double confidence         = clamp(raw.get("confidence"));
            List<String> whatWorked   = parseStringList(raw.get("whatWorked"));
            List<String> whatFailed   = parseStringList(raw.get("whatFailed"));
            String suggestedRule      = raw.get("suggestedRule") instanceof String s ? s : "";
            List<String> reasonCodes  = parseStringList(raw.get("reasonCodes"));
            List<String> warningCodes = parseStringList(raw.get("warningCodes"));

            return new TradeReviewAiOutput(quality, avoidable, mistakeType, confidence,
                    summary, whatWorked, whatFailed, suggestedRule, reasonCodes, warningCodes);

        } catch (Exception e) {
            log.warn("Failed to parse OpenAI review response — falling back. error={}", e.getMessage());
            throw new OpenAiException("Review JSON parse failed: " + e.getMessage(), e, OpenAiClient.OpenAiException.Category.PARSE_FAILURE);
        }
    }

    private TradeQuality resolveQuality(Object raw) {
        if (!(raw instanceof String s)) return TradeQuality.UNKNOWN;
        return switch (s.trim().toUpperCase()) {
            case "GOOD", "GOOD_TRADE"       -> TradeQuality.GOOD;
            case "BAD",  "BAD_TRADE"        -> TradeQuality.BAD;
            case "NEUTRAL", "NEUTRAL_TRADE" -> TradeQuality.NEUTRAL;
            case "AVERAGE"                  -> TradeQuality.AVERAGE;
            default                         -> TradeQuality.UNKNOWN;
        };
    }

    private MistakeType resolveMistakeType(Object raw) {
        // Handle "mistakes": ["REVERSAL_TRAP", ...] — take first element
        if (raw instanceof List<?> list) raw = list.isEmpty() ? null : list.get(0);
        if (!(raw instanceof String s)) return MistakeType.UNKNOWN;
        return switch (s.trim().toUpperCase()) {
            case "NONE", "NO_CLEAR_MISTAKE", "NO_MISTAKE" -> MistakeType.NONE;
            case "REVERSAL_TRAP"                          -> MistakeType.REVERSAL_TRAP;
            case "LATE_ENTRY"                             -> MistakeType.LATE_ENTRY;
            case "BAD_EXIT"                               -> MistakeType.BAD_EXIT;
            case "BAD_ENTRY"                              -> MistakeType.BAD_ENTRY;
            case "WEAK_CONFIRMATION", "WEAK_SIGNAL"       -> MistakeType.WEAK_CONFIRMATION;
            case "OVEREXTENSION", "OVEREXTENDED_ENTRY"    -> MistakeType.OVEREXTENSION;
            case "CHOP_ENTRY"                             -> MistakeType.CHOP_ENTRY;
            case "COUNTER_TREND_ENTRY"                    -> MistakeType.COUNTER_TREND_ENTRY;
            case "MARKET_NOISE"                           -> MistakeType.MARKET_NOISE;
            default                                       -> MistakeType.UNKNOWN;
        };
    }

    private boolean resolveAvoidable(Map<?, ?> raw, List<String> aliasesUsed) {
        Object val = raw.get("avoidable");
        if (val instanceof Boolean b) return b;
        // "avoidability": "AVOIDABLE" / "NOT_AVOIDABLE"
        Object avoidability = raw.get("avoidability");
        if (avoidability instanceof String s) {
            aliasesUsed.add("avoidable←avoidability");
            return "AVOIDABLE".equalsIgnoreCase(s.trim());
        }
        return false;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    /** Parses "2026-04-29T09:55" (LocalDateTime string from Strategy Engine) to Instant using IST. */
    private Instant parseToInstant(String s) {
        if (s == null || s.isBlank()) return null;
        try { return LocalDateTime.parse(s).atZone(IST).toInstant(); }
        catch (Exception e) { return null; }
    }

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
