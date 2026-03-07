package com.sma.dataengine.model.request;

import com.sma.dataengine.model.Interval;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * Request to start a historical data replay session.
 * Candles are emitted as CandleDataEvents at a controlled rate,
 * simulating a live feed for strategy testing.
 *
 * When apiKey + accessToken are provided (on-demand mode), the service fetches
 * data from the broker API automatically (DB cache checked first).
 * Without credentials, it falls back to reading pre-persisted candles from DB.
 */
@Data
public class ReplayRequest {

    @NotBlank
    private String userId;

    /** Broker credentials — required for on-demand API fetch. */
    private String brokerName;
    private String apiKey;
    private String accessToken;

    /** Numeric instrument token to replay. */
    @NotNull
    private Long instrumentToken;

    /** Symbol for display (e.g. "NIFTY25MAYFUT"). */
    private String symbol;

    /** Exchange (e.g. "NSE", "NFO"). */
    private String exchange;

    @NotNull
    private Interval interval;

    @NotNull
    private LocalDateTime fromDate;

    @NotNull
    private LocalDateTime toDate;

    /**
     * Emission speed: candles per second.
     * 1 = one candle/sec (default, good for UI visualization).
     * 10 = ten candles/sec (fast forward for backtesting).
     * Max 100 to prevent resource exhaustion.
     */
    @Min(1)
    @Max(100)
    private int speedMultiplier = 1;

    /** Data provider / broker name for API fetch (defaults to "kite"). */
    private String provider = "kite";

    /**
     * Whether to persist fetched candles to DB.
     * Ignored when loading from DB cache. Defaults to true.
     */
    private boolean persist = true;
}
