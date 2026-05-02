package com.sma.aiengine.client;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
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
import java.util.List;
import java.util.Map;

@Slf4j
@Component
@RequiredArgsConstructor
public class OpenAiClient {

    private static final String OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

    private final OpenAiConfig config;
    private final ObjectMapper objectMapper;

    /**
     * Sends a chat completion request to OpenAI and returns the content string.
     * The content string is expected to be valid JSON (json_object response format is requested).
     *
     * @throws OpenAiException on HTTP error, timeout, or unexpected response shape
     */
    public String chat(String systemPrompt, String userContent) {
        try {
            Map<String, Object> body = Map.of(
                "model", config.getModel(),
                "response_format", Map.of("type", "json_object"),
                "max_tokens", config.getMaxTokens(),
                "messages", List.of(
                    Map.of("role", "system", "content", systemPrompt),
                    Map.of("role", "user",   "content", userContent)
                )
            );

            String requestBody = objectMapper.writeValueAsString(body);

            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(config.getTimeoutSeconds()))
                    .build();

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(OPENAI_CHAT_URL))
                    .timeout(Duration.ofSeconds(config.getTimeoutSeconds()))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + config.getApiKey())
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                    .build();

            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() != 200) {
                throw new OpenAiException("OpenAI returned HTTP " + response.statusCode() + ": " + response.body());
            }

            ChatCompletionResponse parsed = objectMapper.readValue(response.body(), ChatCompletionResponse.class);

            if (parsed.choices() == null || parsed.choices().isEmpty()) {
                throw new OpenAiException("OpenAI response contained no choices");
            }

            String content = parsed.choices().get(0).message().content();
            if (content == null || content.isBlank()) {
                throw new OpenAiException("OpenAI response content was empty");
            }

            return content;

        } catch (OpenAiException e) {
            throw e;
        } catch (Exception e) {
            throw new OpenAiException("OpenAI call failed: " + e.getMessage(), e);
        }
    }

    // ── Response shape records ───────────────────────────────────────────────

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ChatCompletionResponse(List<Choice> choices) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Choice(Message message) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Message(String role, String content) {}

    // ── Exception ────────────────────────────────────────────────────────────

    public static class OpenAiException extends RuntimeException {
        public OpenAiException(String message) { super(message); }
        public OpenAiException(String message, Throwable cause) { super(message, cause); }
    }
}
