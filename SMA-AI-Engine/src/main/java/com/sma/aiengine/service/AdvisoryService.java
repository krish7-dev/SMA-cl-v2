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

            CANDLE SEMANTICS (instrumentContext=UNDERLYING — recentCandles are NIFTY price candles, not option premium):
            - Long PE (bearish): DOWN underlying candles SUPPORT the trade. UP candles OPPOSE the trade.
            - Long CE (bullish): UP underlying candles SUPPORT the trade. DOWN candles OPPOSE the trade.
            Use the precomputed field recentMomentumAlignment (SUPPORTS_TRADE | OPPOSES_TRADE | MIXED) directly.
            Do NOT re-derive direction alignment from raw candles if recentMomentumAlignment is provided.
            If recentMomentumAlignment=SUPPORTS_TRADE → candles favor entry. Do NOT say candles contradict this trade.
            If recentMomentumAlignment=OPPOSES_TRADE → candles work against entry. Increase reversalRisk.

            Field quick guide: scoreGap<5=weak setup; recentMove3/5CandlePct are UNSIGNED NIFTY % moves (always>=0; 0.28=0.28%)
            — use recentMomentumAlignment for direction context (SUPPORTS_TRADE+>=1.5%=overextension; OPPOSES_TRADE+>=1.5%=reversal risk);
            adx>=25+aligned=strong trend; regime values: COMPRESSION/TRENDING/VOLATILE/RANGING;
            barsSinceLastTrade<=1+isOppositeSideAfterStrongWinner=reversal trap; recentCandlesOpposeTradeCount>=4=CAUTION minimum.
            CRITICAL UNIT RULE: recentMove3/5CandlePct are already % values — 0.169=0.169% NOT 16.9%. Flag overextension ONLY when recentMove3CandlePct>=1.5 or recentMove5CandlePct>=2.5. If both<1.0, NEVER use overextension/surge/stretched/chased language.

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

            CANDLE SEMANTICS (instrumentContext=UNDERLYING — recentCandles are NIFTY price candles, not option premium):
            - Long PE (bearish): DOWN underlying candles SUPPORT the trade. UP candles OPPOSE the trade.
            - Long CE (bullish): UP underlying candles SUPPORT the trade. DOWN candles OPPOSE the trade.
            Use the precomputed field recentMomentumAlignment (SUPPORTS_TRADE | OPPOSES_TRADE | MIXED) directly.
            Do NOT re-derive direction alignment from raw candles if recentMomentumAlignment is provided.
            If recentMomentumAlignment=SUPPORTS_TRADE → candles favor entry. Do NOT say candles contradict this trade.
            If recentMomentumAlignment=OPPOSES_TRADE → candles work against entry. Increase reversalRisk.

            Field interpretation guide:
              winningScore/scoreGap: <20/<5 = weak setup (consider CAUTION). >=30/>=8 = strong (consider ALLOW if candles agree).
              recentMove3/5CandlePct: UNSIGNED absolute NIFTY % move (0.28=0.28%). Always >= 0. Use with recentMomentumAlignment:
                SUPPORTS_TRADE + >=1.5% = entered late in strong same-direction move → overextension risk. Flag OVEREXTENDED_MOVE.
                OPPOSES_TRADE + >=1.5% = large counter-trend move before entry → reversal risk.
              CRITICAL UNIT RULE: recentMove3/5CandlePct are already % values — 0.169=0.169% NOT 16.9%. Flag overextension ONLY when recentMove3CandlePct>=1.5 or recentMove5CandlePct>=2.5. If both<1.0, NEVER use overextension/surge/stretched/chased language.
              vwapDistancePct: signed (+ve=above VWAP). CE above / PE below = VWAP confirms direction. Reverse = counter-VWAP entry.
              adx >= 25: positive when trade direction aligns with trend; headwind when trade opposes existing trend.
              regime: COMPRESSION=avoid; TRENDING=trending market (direction from strategy signals not regime label); VOLATILE=high risk; RANGING=normal.
              directionalConsistencyPassed=false: candle inconsistency at entry. Increase chopRisk.
              barsSinceLastTrade <=1 + isOppositeSideAfterStrongWinner=true: reversal trap risk — apply Section 3.
              recentCandlesOpposeTradeCount >= 4: strong candle headwind → CAUTION minimum.
              dailyPnlBeforeTrade: context only. Negative = possible recovery-mode; not a hard block.

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

            CANDLE SEMANTICS — instrumentContext=UNDERLYING means recentCandles are NIFTY price candles (NOT option premium).
            The payload includes precomputed alignment fields. Use them directly — do NOT re-derive from raw candle data:
              recentMomentumAlignment        = SUPPORTS_TRADE | OPPOSES_TRADE | MIXED
              recentCandlesSupportTradeCount = candles that favor this trade (DOWN for PE, UP for CE)
              recentCandlesOpposeTradeCount  = candles that work against this trade
              lastCandleSupportsTrade        = true/false — whether the most recent candle favors this trade
            RULE: If recentMomentumAlignment=SUPPORTS_TRADE → candles favor this entry. Do NOT say candles contradict or oppose this trade.
            RULE: If recentMomentumAlignment=OPPOSES_TRADE  → candles work against entry. Increase reversalRisk and consider CAUTION.
            RULE: If recentMomentumAlignment=MIXED          → neutral momentum; evaluate other factors.
            NEVER call DOWN candles unfavorable for PE. NEVER call UP candles unfavorable for CE.

            ══════════════════════════════════════════════════════════
            SECTION 1B — FIELD INTERPRETATION GUIDE (read before scoring)
            ══════════════════════════════════════════════════════════
            These fields give context — use them holistically, not mechanically. Null = not available; do not penalize.

            STRATEGY SCORES:
              winningScore (0–100): strategy confidence for this direction. <20=weak, 20–29=moderate, >=30=strong.
              oppositeScore: score for opposing direction. High = contested setup.
              scoreGap = winningScore − oppositeScore: <5=WEAK_SCORE_GAP (add to warningCodes), >=8=strong confirmation.
              regime: exact values are TRENDING, RANGING, VOLATILE, COMPRESSION.
                COMPRESSION → mandatory AVOID (tight range, no directional energy).
                TRENDING → strong trend detected (ADX > threshold). Direction comes from strategy signals, not the regime label.
                VOLATILE → large swings but no clear direction. Increased risk.
                RANGING → moderate conditions. Normal evaluation applies.

            MOVEMENT FIELDS (IMPORTANT: recentMove3CandlePct and recentMove5CandlePct are UNSIGNED — always >= 0):
              recentMove3CandlePct: absolute % price change of NIFTY over last 3 candles (0.28 means 0.28%).
                This is a MAGNITUDE only — does NOT tell you direction. Direction comes from recentMomentumAlignment.
                >1.0%: notable move. >=1.5%: strategy's own penalty threshold (entries here were penalized; if still allowed, score was very high). >2.0%: significant.
                Interpret WITH recentMomentumAlignment:
                  SUPPORTS_TRADE + recentMove3CandlePct >= 1.5% = entered late in a strong same-direction move → OVEREXTENSION risk.
                  OPPOSES_TRADE + recentMove3CandlePct >= 1.5% = large counter-direction move before entry → reversal risk.
              recentMove5CandlePct: same pattern over 5 candles. Strategy penalty threshold: 2.5%.
                SUPPORTS_TRADE + recentMove5CandlePct > 2.0% = trend may be exhausted → overextension risk.
                OPPOSES_TRADE + recentMove5CandlePct > 2.0% = strong counter-trend momentum → high reversal risk.
              CRITICAL UNIT RULE: recentMove3/5CandlePct are already % values — 0.169 means 0.169%, NOT 16.9%. Never multiply by 100.
                Flag OVEREXTENDED_MOVE or use overextension/surge/stretched/chased language ONLY when recentMove3CandlePct >= 1.5 OR recentMove5CandlePct >= 2.5.
                If BOTH recentMove3CandlePct < 1.0 AND recentMove5CandlePct < 1.0: small moves — NEVER use overextension, surge, stretched, or chased language based on these fields.
              vwapDistancePct: signed distance from VWAP (+ve=NIFTY above VWAP, −ve=NIFTY below VWAP).
                CE (bullish): NIFTY above VWAP (positive) = VWAP confirms bullish momentum.
                PE (bearish): NIFTY below VWAP (negative) = VWAP confirms bearish momentum.
                Counter-VWAP (CE below VWAP OR PE above VWAP) = trade is against VWAP direction → increase reversalRisk.
              candleBodyPct: |close − open| / open * 100 (unsigned, % of NIFTY price). Both candleBodyPct and atrPct are in the same unit, so compare them directly.
                candleBodyPct < atrPct * 0.1 = very weak/doji candle (body much smaller than typical range).
                candleBodyPct > atrPct * 0.5 = meaningful conviction candle (body is half the typical range).
                candleBodyPct > atrPct * 0.8 = strong momentum candle.
                If atrPct is null: rough thresholds are <0.05% = very weak, >0.15% = strong (5-min NIFTY typical range).
              adx: trend strength. <20=choppy, 20–25=developing, >=25=trending, >=40=strongly trending.
                HIGH ADX aligned with trade direction = positive (strong trend supports entry).
                HIGH ADX against trade direction = momentum headwind (existing trend may resist reversal).
              atrPct: volatility as % of price. Higher ATR = wider expected swings; riskier entry timing.

            FILTER BOOLEANS:
              compressionNoTradeEnabled=true + regime=COMPRESSION → system-detected block. Use AVOID.
              minMovementFilterPassed=false → insufficient price movement. Increase chopRisk.
              directionalConsistencyPassed=false → candles inconsistent with this direction. Increase reversalRisk.
              candleStrengthFilterPassed=false → current candle too weak. Add WEAK_CANDLE_SIGNAL warning.
              Multiple false filters → strong CAUTION or AVOID signal.

            TRADE SESSION CONTEXT:
              barsSinceLastTrade: <2 = rapid re-entry. Combined with isOppositeSideAfterStrongWinner = reversal risk.
              tradesToday: context only. High count alone does not block entry.
              dailyPnlBeforeTrade: psychological context only. Very negative = possible recovery-mode trading. Not a hard block.
              optionPremium: cost of entry. Very high relative to capital = outsized risk per trade.

            PREVIOUS TRADE CONTEXT:
              isOppositeSideAfterStrongWinner=true: this trade is OPPOSITE direction after a strong winner. Gate for Section 3.
              previousTradeWasStrongWinner=true: prior trade gained >8%. Strong momentum existed in that direction.
              minutesSincePreviousExit <=1: same-candle or immediate re-entry. + isOppositeSideAfterStrongWinner = high reversal trap risk.
              previousTradePnlPct >= 5.0: treated as strong winner even if previousTradeWasStrongWinner not explicitly set.

            CANDLE ALIGNMENT (PRECOMPUTED — use as primary source; lower confidence if raw candles appear to conflict):
              instrumentContext=UNDERLYING: recentCandles are NIFTY price candles, NOT option premium.
              recentCandlesSupportTradeCount: candles favoring this trade. >=3 of 5 = momentum confirmed.
              recentCandlesOpposeTradeCount: candles working against this trade. >=4 of 5 = strong headwind → CAUTION minimum.
              lastCandleSupportsTrade=false: most recent candle does NOT support entry → momentum may be fading.
              recentMomentumAlignment: SUPPORTS_TRADE=candles confirm, OPPOSES_TRADE=candles headwind, MIXED=neutral.
              If recentMomentumAlignment conflicts with what raw recentCandles appear to show: trust recentMomentumAlignment and lower your confidence slightly rather than overriding it — the precomputed value uses the correct CE/PE direction semantics.

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
            OVEREXTENSION (recentMove3/5 are UNSIGNED magnitudes — combine with recentMomentumAlignment for direction context):
              Overextension INCREASES risk — it does NOT mechanically force CAUTION or AVOID if scoreGap, ADX, and candle alignment are strong.
              recentMove3CandlePct >= 1.0% + SUPPORTS_TRADE: notable late-entry risk. overextensionRisk += 0.15.
              recentMove3CandlePct >= 1.5% + SUPPORTS_TRADE: strategy's penalty threshold — likely overextended. overextensionRisk += 0.30. Add OVEREXTENDED_MOVE to warningCodes. If other risk factors are also elevated, consider CAUTION.
              recentMove3CandlePct >= 1.5% + OPPOSES_TRADE: large counter-trend move before entry. Increase reversalRisk instead (not overextensionRisk).
              recentMove5CandlePct >= 2.0% + SUPPORTS_TRADE: additional overextensionRisk += 0.15 (5-candle trend may be exhausted).
            WEAK SETUP: If scoreGap < 5 or winningScore < 20: lateEntryRisk += 0.2. Flag WEAK_SCORE_GAP.

            ══════════════════════════════════════════════════════════
            SECTION 7 — DECISION HIERARCHY (evaluate steps in order, stop at first match)
            ══════════════════════════════════════════════════════════
            Step 1 — COMPRESSION: regime = COMPRESSION → AVOID, chopRisk=0.90, riskLevel=HIGH. STOP.
            Step 2 — Confirmed reversal trap: ALL Section 3 gate conditions met AND direction NOT confirmed
                     → AVOID (clear invalid entry), reversalRisk>=0.80, riskLevel=HIGH, warningCodes include REVERSAL_TRAP.
            Step 3 — Strong reversal warning (gate partial or unconfirmed): isOppositeSideAfterStrongWinner=true
                     AND no reversal confirmation → CAUTION minimum, reversalRisk>=0.65.
            Step 4 — Candle headwind: recentMomentumAlignment=OPPOSES_TRADE AND recentCandlesOpposeTradeCount>=4
                     → CAUTION minimum. Do not assign ALLOW.
            Step 5 — Weak setup: scoreGap<5 OR winningScore<20 → lateEntryRisk+=0.2. Consider CAUTION.
            Step 6 — Filter failures: directionalConsistencyPassed=false OR candleStrengthFilterPassed=false
                     → increase risk flags. Consider CAUTION.
            Step 7 — Strong setup: recentMomentumAlignment=SUPPORTS_TRADE AND scoreGap>=8 AND no trap conditions
                     → ALLOW, riskLevel=LOW or MEDIUM.
            Step 8 — Default: Use CAUTION for ambiguous setups. ALLOW only when confirmation is clear and risks are low.

            ALLOW   = Direction confirmed by candles, solid score gap, no trap or headwind. Proceed.
            CAUTION = Meaningful risk — candle headwind, weak score, rapid re-entry, mild overextension, filter failure. Strategy may enter; AI flags concern.
            AVOID   = COMPRESSION regime OR confirmed reversal trap (clear invalid setup).
            BLOCK   = Reserved for future hard-block conditions requiring downstream override (currently: do not use).

            NEVER use AVOID for mild concerns (weak score, slight overextension). NEVER use BLOCK as a substitute for AVOID.

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
    private static final Set<String> OPPOSITION_FRAMING_KEYWORDS = Set.of(
            "oppose", "opposes", "opposing", "headwind", "unfavorable", "contrary",
            "works against", "not supporting", "counter to"
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

        // ── ALLOW + OPPOSES_TRADE + high oppose count → CAUTION ────────────────
        if (action == AdvisoryAction.ALLOW
                && "OPPOSES_TRADE".equals(req.getRecentMomentumAlignment())
                && req.getRecentCandlesOpposeTradeCount() != null
                && req.getRecentCandlesOpposeTradeCount() >= 4) {
            String msg = "MOMENTUM_OPPOSES_ALLOW_ACTION: ALLOW downgraded to CAUTION — "
                    + "recentMomentumAlignment=OPPOSES_TRADE + opposeCount="
                    + req.getRecentCandlesOpposeTradeCount();
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            action = AdvisoryAction.CAUTION;
            if (!warningCodes.contains("MOMENTUM_OPPOSES_ALLOW_ACTION")) {
                warningCodes.add("MOMENTUM_OPPOSES_ALLOW_ACTION");
            }
        }

        // ── ALLOW + isOppositeSideAfterStrongWinner + candles not confirming → CAUTION ─
        if (action == AdvisoryAction.ALLOW
                && Boolean.TRUE.equals(req.getIsOppositeSideAfterStrongWinner())
                && !"SUPPORTS_TRADE".equals(req.getRecentMomentumAlignment())) {
            String msg = "REVERSAL_TRAP_ALLOW_DOWNGRADE: ALLOW downgraded to CAUTION — "
                    + "isOppositeSideAfterStrongWinner=true + recentMomentumAlignment="
                    + req.getRecentMomentumAlignment() + " (candles not confirming reversal)";
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            action = AdvisoryAction.CAUTION;
            if (!warningCodes.contains("REVERSAL_TRAP_ALLOW_DOWNGRADE")) {
                warningCodes.add("REVERSAL_TRAP_ALLOW_DOWNGRADE");
            }
        }

        // ── OVEREXTENSION_UNIT_ERROR: AI flagged overextension but both moves are tiny ─
        {
            Double m3u = req.getRecentMove3CandlePct();
            Double m5u = req.getRecentMove5CandlePct();
            if (m3u != null && m3u < 1.0 && m5u != null && m5u < 1.0) {
                boolean hadOverextCode = warningCodes.stream().anyMatch(c ->
                        c.equals("OVEREXTENDED_MOVE") || c.contains("OVEREXTENSION") || c.contains("OVEREXTENDED"));
                if (hadOverextCode) {
                    warningCodes.removeIf(c ->
                            c.equals("OVEREXTENDED_MOVE") || c.contains("OVEREXTENSION") || c.contains("OVEREXTENDED"));
                    String msg = "OVEREXTENSION_UNIT_ERROR: removed overextension codes — "
                            + "recentMove3CandlePct=" + m3u + " recentMove5CandlePct=" + m5u
                            + " (both < 1.0%; these are small moves — not overextended)";
                    warnings.add(msg);
                    log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
                    if (action == AdvisoryAction.AVOID) {
                        warnings.add("OVEREXTENSION_UNIT_ERROR_DOWNGRADE: AVOID→CAUTION — overextension was the only basis but moves are tiny");
                        action = AdvisoryAction.CAUTION;
                    }
                }
            }
        }

        boolean directionContradictionFound = false;

        // ── PE direction contradiction (per-sentence to avoid false positives on opposition framing) ──
        if ("PE".equals(optType) && hasAdvisoryDirectionContradiction(summary, UP_DIRECTION_KEYWORDS)) {
            String msg = "DIRECTION_EXPLANATION_CONTRADICTION: PE is bearish (benefits from DOWN). "
                    + "Summary describes upward/bullish movement as supportive — this is incorrect.";
            warnings.add(msg);
            log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
            directionContradictionFound = true;
        }
        // ── CE direction contradiction (per-sentence to avoid false positives on opposition framing) ──
        if ("CE".equals(optType) && hasAdvisoryDirectionContradiction(summary, DOWN_DIRECTION_KEYWORDS)) {
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

        // ── Momentum alignment contradiction check ────────────────────────────
        // Catches AI saying "candles contradict PE" when DOWN candles actually support PE, etc.
        String momentumAlignment = req.getRecentMomentumAlignment();
        if (momentumAlignment != null && output.summary() != null) {
            String sl = output.summary().toLowerCase(Locale.ROOT);
            if ("SUPPORTS_TRADE".equals(momentumAlignment)) {
                boolean aiSaysContradicts = sl.contains("contradict") || sl.contains("candles oppose")
                        || sl.contains("momentum opposite") || sl.contains("momentum_opposite")
                        || sl.contains("candles work against") || sl.contains("recent candles against");
                if (aiSaysContradicts) {
                    String msg = "MOMENTUM_ALIGNMENT_CONTRADICTION: recentMomentumAlignment=SUPPORTS_TRADE "
                            + "but summary implies candles contradict trade direction.";
                    warnings.add(msg);
                    log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
                    if (!warningCodes.contains("AI_DIRECTION_REASONING_INVALID")) {
                        warningCodes.add("AI_DIRECTION_REASONING_INVALID");
                    }
                }
            } else if ("OPPOSES_TRADE".equals(momentumAlignment)) {
                boolean aiSaysSupports = (sl.contains("candles support") || sl.contains("momentum supports")
                        || sl.contains("candles align") || sl.contains("candles favor"))
                        && !sl.contains("not") && !sl.contains("don't") && !sl.contains("do not");
                if (aiSaysSupports) {
                    String msg = "MOMENTUM_ALIGNMENT_CONTRADICTION: recentMomentumAlignment=OPPOSES_TRADE "
                            + "but summary implies candles support trade direction.";
                    warnings.add(msg);
                    log.warn("[{}] VALIDATION_WARNING: {}", requestId, msg);
                    if (!warningCodes.contains("AI_DIRECTION_REASONING_INVALID")) {
                        warningCodes.add("AI_DIRECTION_REASONING_INVALID");
                    }
                }
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

    private boolean hasAdvisoryDirectionContradiction(String summary, Set<String> directionKeywords) {
        String[] sentences = summary.split("[.!?]+\\s*");
        for (String sentence : sentences) {
            if (sentence.isBlank()) continue;
            boolean hasDir    = directionKeywords.stream().anyMatch(sentence::contains);
            boolean hasSupp   = SUPPORT_FRAMING_KEYWORDS.stream().anyMatch(sentence::contains);
            boolean hasOppFrm = OPPOSITION_FRAMING_KEYWORDS.stream().anyMatch(sentence::contains);
            if (hasDir && hasSupp && !hasOppFrm) return true;
        }
        return false;
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
