package com.sma.aiengine.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "ai.openai")
@Getter
@Setter
public class OpenAiConfig {

    private String apiKey = "";
    private String model = "gpt-4o-mini";
    private boolean enabled = false;
    private int timeoutSeconds = 15;
    private int maxTokens = 1000;
    private String apiMode = "chat_completions";  // chat_completions | responses
    private String promptMode = "strict";          // strict | minimal | hybrid
    private String reasoningEffort = "";           // low | medium | high (empty = omit)
    private int reasoningTimeoutSeconds = 60;
    private int reasoningMaxTokens = 16000;
}
