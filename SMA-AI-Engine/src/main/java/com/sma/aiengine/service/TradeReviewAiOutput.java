package com.sma.aiengine.service;

import com.sma.aiengine.model.enums.MistakeType;
import com.sma.aiengine.model.enums.TradeQuality;

import java.util.List;

record TradeReviewAiOutput(
        TradeQuality quality,
        boolean avoidable,
        MistakeType mistakeType,
        double confidence,
        String summary,
        List<String> whatWorked,
        List<String> whatFailed,
        String suggestedRule,
        List<String> reasonCodes,
        List<String> warningCodes
) {
    static TradeReviewAiOutput unknown() {
        return new TradeReviewAiOutput(
                TradeQuality.UNKNOWN, false, MistakeType.UNKNOWN,
                0.0, "", List.of(), List.of(), "", List.of(), List.of()
        );
    }
}
