package com.sma.dataengine.model;

import jakarta.validation.constraints.NotNull;
import lombok.Data;

/**
 * Identifies a single instrument to subscribe to for live market data.
 * instrumentToken is the numeric exchange token (e.g. 738561 for RELIANCE NSE).
 */
@Data
public class InstrumentSubscription {

    /** Broker-issued numeric token — used for WebSocket subscriptions. */
    @NotNull
    private Long instrumentToken;

    /** Human-readable symbol for logging and persistence (e.g. "RELIANCE"). */
    private String symbol;

    /** Exchange (e.g. "NSE", "BSE", "NFO", "MCX"). */
    private String exchange;
}
