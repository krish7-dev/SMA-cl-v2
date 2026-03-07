package com.sma.dataengine.adapter;

import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.SubscriptionMode;
import com.sma.dataengine.model.TickData;
import com.sma.dataengine.model.request.HistoricalDataRequest;

import java.util.List;
import java.util.function.Consumer;

/**
 * Abstraction over any market data provider (Kite, Upstox, Angel, etc.).
 *
 * Responsibilities:
 * - Manage WebSocket lifecycle for live tick streaming
 * - Fetch historical OHLCV candles via REST
 *
 * Strictly NOT responsible for:
 * - Broker authentication or token lifecycle (owned by SMA-Broker-Engine)
 * - Order placement, cancellation, or portfolio data
 *
 * Implementations must be stateful (hold connection reference) and thread-safe.
 */
public interface MarketDataAdapter {

    /** Unique identifier for this provider, e.g. "kite". Must be lowercase. */
    String getProviderName();

    // ─── WebSocket Lifecycle ───────────────────────────────────────────────────

    /**
     * Opens the WebSocket connection to the broker's live feed.
     * Idempotent — calling connect() on an already-connected adapter is a no-op.
     *
     * @param apiKey      Broker API key (not stored — used only during connect)
     * @param accessToken Live session token obtained from SMA-Broker-Engine
     */
    void connect(String apiKey, String accessToken);

    /**
     * Gracefully closes the WebSocket connection and clears all subscriptions.
     * Safe to call even if not connected.
     */
    void disconnect();

    /** Returns true if the WebSocket connection is currently open. */
    boolean isConnected();

    // ─── Subscription Management ───────────────────────────────────────────────

    /**
     * Subscribes to live ticks for the given instrument tokens.
     * Adapter must be connected before calling this.
     *
     * @param instrumentTokens Broker-issued numeric tokens
     * @param mode             Depth of tick data (LTP / QUOTE / FULL)
     */
    void subscribe(List<Long> instrumentTokens, SubscriptionMode mode);

    /**
     * Removes the given instrument tokens from the active subscription.
     * Does not disconnect the underlying WebSocket.
     */
    void unsubscribe(List<Long> instrumentTokens);

    // ─── Tick Listener ─────────────────────────────────────────────────────────

    /**
     * Registers a callback that receives normalized TickData on every tick arrival.
     * Must be set before calling connect() so no ticks are missed.
     * The consumer is called on the broker's network/IO thread — keep it non-blocking.
     */
    void setTickListener(Consumer<List<TickData>> listener);

    // ─── Historical Data ───────────────────────────────────────────────────────

    /**
     * Fetches historical OHLCV candles from the broker REST API.
     * This is a synchronous, blocking call.
     *
     * @param request Fully populated historical data request
     * @return Ordered list of normalized CandleData (oldest first)
     * @throws MarketDataAdapterException on broker API error or network failure
     */
    List<CandleData> getHistoricalData(HistoricalDataRequest request);
}
