package com.sma.dataengine.model;

import lombok.Builder;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * Normalized OHLCV candle data — broker-agnostic representation of a time-series bar.
 * Returned by historical data fetches and emitted during replay sessions.
 */
@Data
@Builder
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
}
