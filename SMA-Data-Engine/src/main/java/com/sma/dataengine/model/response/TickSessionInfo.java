package com.sma.dataengine.model.response;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * Metadata about a recorded live tick session.
 * Returned by GET /api/v1/data/ticks/sessions.
 */
@Data
@Builder
public class TickSessionInfo {
    private String          sessionId;
    private LocalDateTime   firstTick;
    private LocalDateTime   lastTick;
    private long            tickCount;
    private List<Long>      instrumentTokens;
    /** token → symbol name, resolved from candle_data where available */
    private Map<Long, String> tokenSymbols;
}
