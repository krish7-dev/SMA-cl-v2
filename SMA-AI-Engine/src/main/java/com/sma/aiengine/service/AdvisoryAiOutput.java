package com.sma.aiengine.service;

import com.sma.aiengine.model.enums.AdvisoryAction;
import com.sma.aiengine.model.enums.RiskLevel;

import java.util.List;

record AdvisoryAiOutput(
        AdvisoryAction action,
        double confidence,
        double tradeQualityScore,
        RiskLevel riskLevel,
        double reversalRisk,
        double chopRisk,
        double lateEntryRisk,
        double overextensionRisk,
        List<String> reasonCodes,
        List<String> warningCodes,
        String summary
) {
    static AdvisoryAiOutput unknown() {
        return new AdvisoryAiOutput(
                AdvisoryAction.UNKNOWN, 0.0, 0.0, RiskLevel.UNKNOWN,
                0.0, 0.0, 0.0, 0.0, List.of(), List.of(), ""
        );
    }
}
