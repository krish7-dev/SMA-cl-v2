package com.sma.aiengine.client;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.aiengine.config.OpenAiConfig;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Component
@RequiredArgsConstructor
public class OpenAiClient {

    private static final String OPENAI_CHAT_URL      = "https://api.openai.com/v1/chat/completions";
    private static final String OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

    private final OpenAiConfig config;
    private final ObjectMapper objectMapper;

    /** Routes to chat/completions or responses API. Uses json_object format. */
    public String chat(String systemPrompt, String userContent) {
        return chat(systemPrompt, userContent, null, null);
    }

    /**
     * Routes to chat/completions or responses API.
     * When schemaName + jsonSchema are provided and apiMode=responses, enforces strict JSON Schema output.
     * Chat completions path ignores schema params (uses json_object).
     *
     * @throws OpenAiException on HTTP error, timeout, truncation, or empty response
     */
    public String chat(String systemPrompt, String userContent,
                       String schemaName, Map<String, Object> jsonSchema) {
        try {
            return "responses".equalsIgnoreCase(config.getApiMode())
                    ? callResponsesApi(systemPrompt, userContent, schemaName, jsonSchema)
                    : callChatCompletions(systemPrompt, userContent);
        } catch (OpenAiException e) {
            throw e;
        } catch (Exception e) {
            OpenAiException.Category cat =
                    (e instanceof java.net.http.HttpTimeoutException
                            || e.getCause() instanceof java.net.http.HttpTimeoutException)
                            ? OpenAiException.Category.TIMEOUT
                            : OpenAiException.Category.UNKNOWN;
            throw new OpenAiException("OpenAI call failed: " + e.getMessage(), e, cat);
        }
    }

    // ── Chat Completions (/v1/chat/completions) ──────────────────────────────

    private String callChatCompletions(String systemPrompt, String userContent) throws Exception {
        Map<String, Object> body = Map.of(
            "model",           config.getModel(),
            "response_format", Map.of("type", "json_object"),
            "max_tokens",      config.getMaxTokens(),
            "messages",        List.of(
                Map.of("role", "system", "content", systemPrompt),
                Map.of("role", "user",   "content", userContent)
            )
        );

        String responseBody = sendRequest(OPENAI_CHAT_URL, body, config.getTimeoutSeconds());

        ChatCompletionResponse parsed;
        try {
            parsed = objectMapper.readValue(responseBody, ChatCompletionResponse.class);
        } catch (Exception parseEx) {
            log.warn("[Chat Completions] Top-level parse failure. Raw body: {}", responseBody);
            throw new OpenAiException("Chat completions parse failed: " + parseEx.getMessage(),
                    parseEx, OpenAiException.Category.PARSE_FAILURE);
        }
        if (parsed.choices() == null || parsed.choices().isEmpty()) {
            log.warn("[Chat Completions] No choices in response. Raw body: {}", responseBody);
            throw new OpenAiException("Chat completions response contained no choices",
                    OpenAiException.Category.CONTENT_EMPTY);
        }
        String content = parsed.choices().get(0).message().content();
        if (content == null || content.isBlank()) {
            log.warn("[Chat Completions] Empty content. Raw body: {}", responseBody);
            throw new OpenAiException("Chat completions response content was empty",
                    OpenAiException.Category.CONTENT_EMPTY);
        }
        String extracted = stripMarkdownFences(content);
        log.info("[Chat Completions] Extracted ({}chars): {}",
                extracted.length(),
                extracted.length() > 300 ? extracted.substring(0, 300) + "..." : extracted);
        return extracted;
    }

    // ── Responses API (/v1/responses) ────────────────────────────────────────

    private String callResponsesApi(String systemPrompt, String userContent,
                                    String schemaName, Map<String, Object> jsonSchema) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", config.getModel());
        String effort = config.getReasoningEffort();
        if (effort != null && !effort.isBlank()) {
            body.put("reasoning", Map.of("effort", effort));
        }
        // 'instructions' is the correct Responses API field for system prompts.
        // Responses API validates that 'json' appears in the input messages (not instructions),
        // so prefix the user content to satisfy the json format requirement.
        body.put("instructions", systemPrompt);
        body.put("input", "Return only valid JSON. Do not include markdown, explanation, or text outside the JSON object.\n\n" + userContent);

        if (schemaName != null && jsonSchema != null) {
            body.put("text", Map.of("format", Map.ofEntries(
                    Map.entry("type",   "json_schema"),
                    Map.entry("name",   schemaName),
                    Map.entry("strict", true),
                    Map.entry("schema", jsonSchema)
            )));
        } else {
            body.put("text", Map.of("format", Map.of("type", "json_object")));
        }
        body.put("max_output_tokens", config.getReasoningMaxTokens());

        log.info("[Responses API] Calling: model={} effort={} maxOutputTokens={} format={}",
                config.getModel(), effort, config.getReasoningMaxTokens(),
                schemaName != null ? "json_schema(" + schemaName + ")" : "json_object");

        String responseBody = sendRequest(OPENAI_RESPONSES_URL, body, config.getReasoningTimeoutSeconds());

        // Always log raw body (truncated) — critical for diagnosing extraction issues
        log.info("[Responses API] Raw body ({}chars): {}",
                responseBody.length(),
                responseBody.length() > 3000 ? responseBody.substring(0, 3000) + "...[truncated]" : responseBody);

        ResponsesApiResponse parsed;
        try {
            parsed = objectMapper.readValue(responseBody, ResponsesApiResponse.class);
        } catch (Exception parseEx) {
            log.warn("[Responses API] Top-level parse failure. Raw body: {}", responseBody);
            throw new OpenAiException("Responses API parse failed: " + parseEx.getMessage(),
                    parseEx, OpenAiException.Category.PARSE_FAILURE);
        }

        // Log status and token usage — reasoning tokens count against max_output_tokens
        String responseStatus = parsed.status();
        if (parsed.usage() != null) {
            ResponsesApiUsage u = parsed.usage();
            Integer reasoning = u.outputTokensDetails() != null ? u.outputTokensDetails().reasoningTokens() : null;
            log.info("[Responses API] status={} tokens: input={} output={} reasoning={} total={}",
                    responseStatus, u.inputTokens(), u.outputTokens(), reasoning, u.totalTokens());
        } else {
            log.info("[Responses API] status={}", responseStatus);
        }

        // Incomplete means max_output_tokens was hit mid-generation
        if ("incomplete".equalsIgnoreCase(responseStatus)) {
            log.warn("[Responses API] Response INCOMPLETE — max_output_tokens={} exhausted by reasoning. "
                    + "Increase reasoning-max-tokens in application.yml.", config.getReasoningMaxTokens());
            throw new OpenAiException(
                    "Responses API response was incomplete (max_output_tokens=" + config.getReasoningMaxTokens()
                            + " too low — reasoning consumed available tokens)",
                    OpenAiException.Category.CONTENT_EMPTY);
        }

        if (parsed.output() == null || parsed.output().isEmpty()) {
            log.warn("[Responses API] Empty output array. Raw body: {}", responseBody);
            throw new OpenAiException("Responses API response contained no output items",
                    OpenAiException.Category.CONTENT_EMPTY);
        }

        // Scan ALL output items and ALL content items for any non-blank text
        for (ResponsesOutputItem item : parsed.output()) {
            log.debug("[Responses API] output item: type={} status={}", item.type(), item.status());
            if (item.content() == null) continue;
            for (ResponsesContentItem ci : item.content()) {
                if (ci.text() == null || ci.text().isBlank()) continue;
                String extracted = stripMarkdownFences(ci.text());
                log.info("[Responses API] Extracted from item.type={} ci.type={} ({}chars): {}",
                        item.type(), ci.type(), extracted.length(),
                        extracted.length() > 500 ? extracted.substring(0, 500) + "..." : extracted);
                return extracted;
            }
        }

        log.warn("[Responses API] No text found in any output item. Raw body: {}", responseBody);
        throw new OpenAiException("Responses API response contained no text content",
                OpenAiException.Category.CONTENT_EMPTY);
    }

    // ── Shared HTTP sender ────────────────────────────────────────────────────

    private String sendRequest(String url, Object body, int timeoutSeconds) throws Exception {
        String requestBody = objectMapper.writeValueAsString(body);

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(timeoutSeconds))
                .build();

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + config.getApiKey())
                .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        log.info("[HTTP] POST {} → HTTP {}", url, response.statusCode());

        if (response.statusCode() != 200) {
            throw new OpenAiException("OpenAI returned HTTP " + response.statusCode() + ": " + response.body(),
                    OpenAiException.Category.HTTP_ERROR);
        }

        return response.body();
    }

    // ── Text cleanup ──────────────────────────────────────────────────────────

    private static String stripMarkdownFences(String text) {
        if (text == null) return null;
        String t = text.strip();
        if (!t.startsWith("```")) return t;
        int firstNewline = t.indexOf('\n');
        if (firstNewline < 0) return t;
        t = t.substring(firstNewline + 1);
        if (t.endsWith("```")) t = t.substring(0, t.length() - 3).strip();
        return t;
    }

    // ── Chat Completions response records ────────────────────────────────────

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ChatCompletionResponse(List<Choice> choices) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Choice(Message message) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Message(String role, String content) {}

    // ── Responses API response records ───────────────────────────────────────

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ResponsesApiResponse(
            List<ResponsesOutputItem> output,
            String status,
            ResponsesApiUsage usage) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ResponsesOutputItem(
            String type,
            String status,
            List<ResponsesContentItem> content) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ResponsesContentItem(String type, String text) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ResponsesApiUsage(
            @JsonProperty("input_tokens")  Integer inputTokens,
            @JsonProperty("output_tokens") Integer outputTokens,
            @JsonProperty("output_tokens_details") OutputTokensDetails outputTokensDetails,
            @JsonProperty("total_tokens")  Integer totalTokens) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record OutputTokensDetails(
            @JsonProperty("reasoning_tokens") Integer reasoningTokens) {}

    // ── Exception ────────────────────────────────────────────────────────────

    public static class OpenAiException extends RuntimeException {
        public enum Category { TIMEOUT, HTTP_ERROR, PARSE_FAILURE, CONTENT_EMPTY, UNKNOWN }
        private final Category category;
        public OpenAiException(String message, Category category) {
            super(message); this.category = category;
        }
        public OpenAiException(String message, Throwable cause, Category category) {
            super(message, cause); this.category = category;
        }
        public Category getCategory() { return category; }
    }
}
