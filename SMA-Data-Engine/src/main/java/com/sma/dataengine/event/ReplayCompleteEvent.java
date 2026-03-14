package com.sma.dataengine.event;

import org.springframework.context.ApplicationEvent;

/**
 * Published by ReplayService after the last candle of a session is emitted.
 * SseStreamController listens for this and sends a "done" SSE event to the
 * matching client so the browser knows all candles have been delivered.
 */
public class ReplayCompleteEvent extends ApplicationEvent {

    private final String sessionId;

    public ReplayCompleteEvent(Object source, String sessionId) {
        super(source);
        this.sessionId = sessionId;
    }

    public String getSessionId() { return sessionId; }
}
