package com.sma.dataengine.model.request;

import com.sma.dataengine.model.CandleData;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import lombok.Data;

import java.util.List;

/**
 * Request payload for ingesting live-recorded candles into the candle_data table.
 *
 * Sent by Strategy Engine after each candle closes during a live options session.
 * Candles are batched by the caller for efficiency — typically 10–50 per request.
 *
 * Fields:
 * - runId      — correlates candles to a specific live session (sessionId from Strategy Engine)
 * - provider   — broker that produced the tick data (e.g. "kite")
 * - sourceType — always "LIVE_RECORDED" for this endpoint
 * - candles    — list of fully-formed OHLCV candles with instrumentToken, interval, openTime
 */
@Data
public class LiveCandleIngestRequest {

    /** Session ID from the live options run — used for audit/tracing. */
    @NotBlank
    private String runId;

    /** Broker / data provider (e.g. "kite"). */
    @NotBlank
    private String provider;

    /**
     * Source type for all candles in this batch.
     * Must be "LIVE_RECORDED". Validated by the service.
     */
    @NotBlank
    private String sourceType;

    /** Candles to persist. Each must have instrumentToken, interval, and openTime set. */
    @NotEmpty
    private List<CandleData> candles;
}
