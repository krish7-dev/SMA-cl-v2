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
 * Candles are loaded from the candle_data table and emitted as CandleDataEvents
 * at a controlled rate, simulating a live feed for strategy testing.
 *
 * Candles must already exist in the DB for the requested range.
 * Call the historical data endpoint first to populate them if needed.
 */
@Data
public class ReplayRequest {

    @NotBlank
    private String userId;

    /** Numeric instrument token to replay. */
    @NotNull
    private Long instrumentToken;

    /** Symbol for display (e.g. "NIFTY25MAYFUT"). */
    private String symbol;

    /** Exchange (e.g. "NSE", "NFO"). */
    private String exchange;

    @NotNull
    private Interval interval;

    /** Replay range start — must have candle data persisted from this point. */
    @NotNull
    private LocalDateTime fromDate;

    /** Replay range end. */
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

    /** Data provider to replay from (defaults to "kite"). */
    private String provider = "kite";
}
