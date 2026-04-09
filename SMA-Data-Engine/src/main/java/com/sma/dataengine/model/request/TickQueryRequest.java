package com.sma.dataengine.model.request;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Request to fetch raw ticks for one session + a set of instrument tokens.
 * Used by POST /api/v1/data/ticks/query.
 */
@Data
public class TickQueryRequest {

    @NotBlank
    private String sessionId;

    @NotNull
    private List<Long> tokens;

    /** Optional — filter ticks at or after this time within the session. */
    private LocalDateTime fromDate;

    /** Optional — filter ticks at or before this time within the session. */
    private LocalDateTime toDate;
}
