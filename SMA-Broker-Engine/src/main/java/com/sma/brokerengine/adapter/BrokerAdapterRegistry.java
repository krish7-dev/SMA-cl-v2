package com.sma.brokerengine.adapter;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Registry that holds all registered {@link BrokerAdapter} implementations.
 * Adapters are auto-discovered as Spring beans and indexed by broker name.
 */
@Component
public class BrokerAdapterRegistry {

    private final Map<String, BrokerAdapter> adapters;

    public BrokerAdapterRegistry(List<BrokerAdapter> adapterList) {
        this.adapters = adapterList.stream()
                .collect(Collectors.toMap(
                        a -> a.getBrokerName().toLowerCase(),
                        Function.identity()
                ));
    }

    /**
     * Resolves the adapter for the given broker name (case-insensitive).
     *
     * @throws UnsupportedBrokerException if no adapter is registered for the broker
     */
    public BrokerAdapter resolve(String brokerName) {
        BrokerAdapter adapter = adapters.get(brokerName.toLowerCase());
        if (adapter == null) {
            throw new UnsupportedBrokerException("No adapter registered for broker: " + brokerName);
        }
        return adapter;
    }

    public static class UnsupportedBrokerException extends RuntimeException {
        public UnsupportedBrokerException(String message) {
            super(message);
        }
    }
}
