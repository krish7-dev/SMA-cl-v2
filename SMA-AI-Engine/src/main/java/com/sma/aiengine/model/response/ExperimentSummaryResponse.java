package com.sma.aiengine.model.response;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

@Getter
@Builder
public class ExperimentSummaryResponse {
    private String sessionId;
    private String aiModel;
    private String aiApiMode;
    private String aiPromptMode;
    private Long advisoryCount;
    private Instant latestCreatedAt;
}
