package com.sma.dataengine.model.request;

import com.sma.dataengine.model.Interval;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * Request parameters for fetching historical OHLCV candle data.
 *
 * The access token is passed by the caller rather than owned by this service.
 * SMA-Data-Engine uses it solely to authenticate the historical data API call.
 */
@Data
public class HistoricalDataRequest {

    @NotBlank
    private String userId;

    @NotBlank
    private String brokerName;

    /**
     * Broker API key — optional. If blank, Data Engine resolves it
     * from SMA-Broker-Engine automatically using userId + brokerName.
     */
    private String apiKey;

    /**
     * Live access token — optional. Auto-resolved from SMA-Broker-Engine
     * when not provided.
     */
    private String accessToken;

    /** Numeric instrument token (e.g. 738561 for RELIANCE NSE). */
    @NotNull
    private Long instrumentToken;

    /** Human-readable symbol for display and persistence (e.g. "RELIANCE"). */
    private String symbol;

    /** Exchange (e.g. "NSE", "NFO", "MCX"). */
    private String exchange;

    /** Candle interval. */
    @NotNull
    private Interval interval;

    /** Range start — inclusive, in exchange local time (IST). */
    @NotNull
    private LocalDateTime fromDate;

    /** Range end — inclusive, in exchange local time (IST). */
    @NotNull
    private LocalDateTime toDate;

    /**
     * Set to true for continuous contract data (relevant for futures instruments).
     * Defaults to false.
     */
    private boolean continuous = false;

    /**
     * When true, fetched candles are persisted to the candle_data table
     * for later replay or cache lookup.
     * Defaults to true.
     */
    private boolean persist = true;
}
