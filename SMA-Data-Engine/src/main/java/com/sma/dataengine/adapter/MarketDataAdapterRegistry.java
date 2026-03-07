package com.sma.dataengine.adapter;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Discovers and indexes all MarketDataAdapter beans by provider name.
 * New adapters are auto-registered simply by implementing MarketDataAdapter
 * and annotating with @Component — no manual wiring required.
 */
@Slf4j
@Component
public class MarketDataAdapterRegistry {

    private final Map<String, MarketDataAdapter> adapters;

    public MarketDataAdapterRegistry(List<MarketDataAdapter> adapterList) {
        this.adapters = adapterList.stream()
                .collect(Collectors.toMap(
                        a -> a.getProviderName().toLowerCase(),
                        Function.identity()
                ));
        log.info("MarketDataAdapterRegistry initialized with providers: {}", this.adapters.keySet());
    }

    /**
     * Returns the adapter for the given provider name.
     *
     * @param providerName e.g. "kite"
     * @throws MarketDataAdapterException if no adapter is registered for the name
     */
    public MarketDataAdapter resolve(String providerName) {
        MarketDataAdapter adapter = adapters.get(providerName.toLowerCase());
        if (adapter == null) {
            throw new MarketDataAdapterException(
                    "No MarketDataAdapter registered for provider: " + providerName
                            + ". Available: " + adapters.keySet());
        }
        return adapter;
    }

    public boolean supports(String providerName) {
        return adapters.containsKey(providerName.toLowerCase());
    }
}
