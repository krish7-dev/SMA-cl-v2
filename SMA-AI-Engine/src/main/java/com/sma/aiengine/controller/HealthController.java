package com.sma.aiengine.controller;

import com.sma.aiengine.config.OpenAiConfig;
import com.sma.aiengine.model.response.ApiResponse;
import com.sma.aiengine.model.response.ExperimentSummaryResponse;
import com.sma.aiengine.service.AdvisoryService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/ai")
@RequiredArgsConstructor
public class HealthController {

    private final OpenAiConfig openAiConfig;
    private final AdvisoryService advisoryService;

    @GetMapping("/health")
    public ResponseEntity<ApiResponse<Map<String, String>>> health() {
        return ResponseEntity.ok(ApiResponse.ok(Map.of("service", "sma-ai-engine", "status", "UP")));
    }

    @GetMapping("/config")
    public ResponseEntity<ApiResponse<Map<String, Object>>> config() {
        Map<String, Object> cfg = new LinkedHashMap<>();
        cfg.put("enabled", openAiConfig.isEnabled());
        cfg.put("model", openAiConfig.getModel());
        cfg.put("apiMode", openAiConfig.getApiMode());
        cfg.put("promptMode", openAiConfig.getPromptMode());
        String effort = openAiConfig.getReasoningEffort();
        cfg.put("reasoningEffort", (effort != null && !effort.isBlank()) ? effort : null);
        return ResponseEntity.ok(ApiResponse.ok(cfg));
    }

    @GetMapping("/experiment-summary")
    public ResponseEntity<ApiResponse<List<ExperimentSummaryResponse>>> experimentSummary() {
        return ResponseEntity.ok(ApiResponse.ok(advisoryService.listExperimentSummaries()));
    }
}
