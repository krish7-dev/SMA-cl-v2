package com.sma.dataengine.event;

import com.sma.dataengine.model.TickData;
import org.springframework.context.ApplicationEvent;

/**
 * Spring application event published on every tick arrival (live or replay).
 *
 * Consumers within this service (e.g. future Strategy Engine adapter or
 * WebSocket broadcaster) can listen with @EventListener without any coupling
 * to the adapter or service layer.
 *
 * For cross-service delivery, replace with a message broker (Kafka, RabbitMQ)
 * when SMA-Strategy-Engine needs to consume ticks.
 */
public class TickDataEvent extends ApplicationEvent {

    private final TickData tick;

    public TickDataEvent(Object source, TickData tick) {
        super(source);
        this.tick = tick;
    }

    public TickData getTick() {
        return tick;
    }
}
