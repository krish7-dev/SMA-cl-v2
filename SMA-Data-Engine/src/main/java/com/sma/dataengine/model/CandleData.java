package com.sma.dataengine.model;

import lombok.Builder;
import lombok.Data;
import lombok.extern.jackson.Jacksonized;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * Normalized OHLCV candle data — broker-agnostic representation of a time-series bar.
 * Returned by historical data fetches and emitted during replay sessions.
 */
@Data
@Builder
@Jacksonized
public class CandleData {

    private Long          instrumentToken;
    private String        symbol;
    private String        exchange;
    private Interval      interval;

    /** Candle open time in UTC. */
    private LocalDateTime openTime;

    private BigDecimal open;
    private BigDecimal high;
    private BigDecimal low;
    private BigDecimal close;
    private Long       volume;
    private Long       openInterest;

    /** Data provider identifier (e.g. "kite"). */
    private String provider;

    /**
     * How this candle was obtained.
     * {@code HISTORICAL_API} — fetched from broker REST/CSV API.
     * {@code LIVE_RECORDED}  — captured from the live WebSocket tick stream.
     * Defaults to {@code HISTORICAL_API} when not explicitly set.
     */
    @Builder.Default
    private String sourceType = "HISTORICAL_API";
}
