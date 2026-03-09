package com.sma.dataengine.model;

import lombok.Builder;
import lombok.Data;

/**
 * Lightweight instrument descriptor returned by the instrument search API.
 */
@Data
@Builder
public class InstrumentInfo {
    private long   instrumentToken;
    private String tradingSymbol;
    private String name;
    private String exchange;
    private String instrumentType;  // EQ, FUT, CE, PE
    private String segment;
    private double lotSize;
    private String expiry;          // yyyy-MM-dd, null for equities
    private double strike;          // 0.0 for non-options
}
