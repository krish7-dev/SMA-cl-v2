package com.sma.dataengine.model.response;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * Response for the capped compare/UI tick query endpoint.
 * The existing {@code POST /api/v1/data/ticks/query} endpoint (used by the replay engine)
 * is NOT changed — it still returns {@code List<TickEntryDto>} directly.
 * This response is returned only by {@code POST /api/v1/data/ticks/query/compare}.
 */
@Data
@Builder
public class TickPageResponse {

    /** The tick entries, sorted by tick_time ASC, capped at the server-side row limit. */
    private List<TickEntryDto> ticks;

    /** True when the session contains more ticks than the server-side cap. */
    private boolean truncated;

    /** Number of rows returned (≤ cap). */
    private long returnedCount;

    /**
     * Total tick rows that match the query (session + optional token/date filters).
     * Always accurate — comes from the DB COUNT query, not an estimate.
     * Zero when {@code truncated = false} (save the extra count query).
     */
    private long totalCount;
}
