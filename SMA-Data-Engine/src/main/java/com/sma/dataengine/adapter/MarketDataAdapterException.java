package com.sma.dataengine.adapter;

/**
 * Thrown when a MarketDataAdapter encounters a broker-side error
 * (e.g. API failure, connection refused, invalid token).
 * Wraps broker-specific exceptions so they do not leak past the adapter layer.
 */
public class MarketDataAdapterException extends RuntimeException {

    public MarketDataAdapterException(String message) {
        super(message);
    }

    public MarketDataAdapterException(String message, Throwable cause) {
        super(message, cause);
    }
}
