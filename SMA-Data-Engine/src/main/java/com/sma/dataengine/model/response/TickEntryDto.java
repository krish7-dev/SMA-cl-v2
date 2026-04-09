package com.sma.dataengine.model.response;

import lombok.Builder;
import lombok.Data;

/**
 * A single tick entry returned by the tick query endpoint.
 * tickTimeMs is epoch-milliseconds (IST tick_time converted to UTC epoch).
 */
@Data
@Builder
public class TickEntryDto {
    private long   instrumentToken;
    private double ltp;
    private long   volume;
    private long   tickTimeMs;
}
