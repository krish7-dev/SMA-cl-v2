package com.sma.dataengine.model;

/**
 * Normalized subscription depth mode.
 * Adapters map these to broker-specific constants (e.g. KiteTicker.MODE_FULL).
 */
public enum SubscriptionMode {

    /** Last traded price only — lowest bandwidth. */
    LTP,

    /** Market quote: LTP + best bid/ask + volume + OHLC. */
    QUOTE,

    /** Full market depth: QUOTE + 5-level order book + OI + tick-by-tick data. */
    FULL
}
