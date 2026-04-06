package com.sma.dataengine.model.request;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.util.List;

/**
 * Request payload for ingesting raw live ticks into the tick_data table.
 * Sent in batches by the Strategy Engine's LiveTickBuffer.
 */
@Data
public class LiveTickIngestRequest {

    @NotBlank
    private String sessionId;

    @NotBlank
    private String provider;

    @NotNull
    private List<TickEntry> ticks;

    @Data
    public static class TickEntry {
        private Long   instrumentToken;
        private String symbol;
        private String exchange;
        private double ltp;
        private long   volume;
        /** ISO-8601 UTC string, e.g. "2026-04-06T09:15:00" */
        private String tickTime;
    }
}
