package com.sma.dataengine.model;

import lombok.Builder;
import lombok.Data;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Normalized live tick data — broker-agnostic representation of a market tick.
 * Adapters translate from broker-specific tick objects (e.g. Kite's Tick class)
 * into this model before publishing to the rest of the platform.
 *
 * Fields that the broker does not provide in the current subscription mode
 * (LTP / QUOTE / FULL) will be null.
 */
@Data
@Builder
public class TickData {

    // ─── Instrument Identity ───────────────────────────────────────────────────

    private Long   instrumentToken;
    private String symbol;
    private String exchange;
    private String provider;

    // ─── Last Trade ────────────────────────────────────────────────────────────

    private BigDecimal lastTradedPrice;
    private Long       lastTradedQuantity;
    private BigDecimal averageTradedPrice;
    private Long       volumeTradedToday;

    // ─── Depth ─────────────────────────────────────────────────────────────────

    private BigDecimal totalBuyQuantity;
    private BigDecimal totalSellQuantity;

    // ─── OHLC (available in QUOTE and FULL modes) ──────────────────────────────

    private BigDecimal openPrice;
    private BigDecimal highPrice;
    private BigDecimal lowPrice;
    private BigDecimal closePrice;

    // ─── Change ────────────────────────────────────────────────────────────────

    /** Absolute change from previous close. */
    private BigDecimal change;

    /** Percentage change from previous close. */
    private BigDecimal changePercent;

    // ─── Open Interest (F&O instruments) ──────────────────────────────────────

    private Long openInterest;

    // ─── Timestamp ─────────────────────────────────────────────────────────────

    /** Exchange-provided timestamp for this tick. */
    private Instant timestamp;

    /** Flag indicating this tick came from a replay session, not a live feed. */
    @Builder.Default
    private boolean replay = false;

    /** Replay session ID if replay == true, null for live ticks. */
    private String replaySessionId;
}
