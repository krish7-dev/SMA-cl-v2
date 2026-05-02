package com.sma.aiengine.model.response;

import java.time.Instant;

public record SessionSummaryResponse(
        String sessionId,
        long   advisoryCount,
        long   reviewCount,
        Instant latestActivity
) {}
