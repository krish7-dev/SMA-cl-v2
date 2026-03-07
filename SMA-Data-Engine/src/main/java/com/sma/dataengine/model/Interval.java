package com.sma.dataengine.model;

/**
 * Normalized candle interval enum.
 * Each constant carries the Kite Connect string representation so adapters
 * can translate without leaking broker-specific values into the rest of the service.
 */
public enum Interval {

    MINUTE_1("minute"),
    MINUTE_3("3minute"),
    MINUTE_5("5minute"),
    MINUTE_10("10minute"),
    MINUTE_15("15minute"),
    MINUTE_30("30minute"),
    MINUTE_60("60minute"),
    DAY("day"),
    WEEK("week"),
    MONTH("month");

    private final String kiteValue;

    Interval(String kiteValue) {
        this.kiteValue = kiteValue;
    }

    /** Returns the Kite Connect API string for this interval. */
    public String getKiteValue() {
        return kiteValue;
    }

    /** Lookup by Kite API string value. */
    public static Interval fromKiteValue(String value) {
        for (Interval i : values()) {
            if (i.kiteValue.equalsIgnoreCase(value)) return i;
        }
        throw new IllegalArgumentException("Unknown Kite interval value: " + value);
    }
}
