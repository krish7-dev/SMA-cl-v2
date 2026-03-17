package com.sma.dataengine.service;

import com.sma.dataengine.adapter.MarketDataAdapter;
import com.sma.dataengine.adapter.MarketDataAdapterRegistry;
import com.sma.dataengine.event.TickDataEvent;
import com.sma.dataengine.model.InstrumentSubscription;
import com.sma.dataengine.model.request.SubscriptionRequest;
import com.sma.dataengine.model.request.UnsubscribeRequest;
import com.sma.dataengine.model.response.SubscriptionResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages live WebSocket market data subscriptions.
 *
 * One session = one (userId, brokerName) pair = one WebSocket connection.
 * Multiple instruments can be added to a session after it is established.
 *
 * Ticks arriving from the adapter are normalized and published as
 * {@link TickDataEvent} on Spring's ApplicationEventPublisher,
 * decoupling the data pipeline from any downstream consumers.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class LiveMarketDataService {

    private final MarketDataAdapterRegistry  adapterRegistry;
    private final ApplicationEventPublisher  eventPublisher;

    /**
     * Active sessions: sessionKey ("{userId}::{brokerName}") → connected adapter.
     * ConcurrentHashMap makes subscribe/unsubscribe thread-safe.
     */
    private final Map<String, MarketDataAdapter> activeSessions = new ConcurrentHashMap<>();

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Establishes the KiteTicker WebSocket connection without subscribing any instruments.
     * Safe to call multiple times — idempotent if already connected.
     */
    public void connect(String userId, String brokerName, String apiKey, String accessToken) {
        String sessionKey = sessionKey(userId, brokerName);
        activeSessions.computeIfAbsent(sessionKey, k -> {
            log.info("Connecting KiteTicker for session: {}", k);
            MarketDataAdapter a = adapterRegistry.resolve(brokerName);
            a.setTickListener(ticks -> ticks.forEach(tick ->
                    eventPublisher.publishEvent(new TickDataEvent(this, tick))
            ));
            a.connect(apiKey, accessToken);
            return a;
        });
    }

    /**
     * Opens a live subscription for the requested instruments.
     * If a session already exists for (userId, brokerName), adds to it.
     * If not, creates a new WebSocket connection via the appropriate adapter.
     */
    public SubscriptionResponse subscribe(SubscriptionRequest request) {
        String sessionKey = sessionKey(request.getUserId(), request.getBrokerName());

        MarketDataAdapter adapter = activeSessions.computeIfAbsent(sessionKey, k -> {
            log.info("Creating new live session: {}", k);
            MarketDataAdapter a = adapterRegistry.resolve(request.getBrokerName());

            // Register tick listener BEFORE connecting so no ticks are missed
            a.setTickListener(ticks -> ticks.forEach(tick ->
                    eventPublisher.publishEvent(new TickDataEvent(this, tick))
            ));

            a.connect(request.getApiKey(), request.getAccessToken());
            return a;
        });

        List<Long> tokens = request.getInstruments().stream()
                .map(InstrumentSubscription::getInstrumentToken)
                .toList();

        adapter.subscribe(tokens, request.getMode());

        log.info("Subscribed session={}, tokens={}, mode={}", sessionKey, tokens, request.getMode());

        return SubscriptionResponse.builder()
                .sessionKey(sessionKey)
                .brokerName(request.getBrokerName())
                .mode(request.getMode().name())
                .subscribedTokens(tokens)
                .status("SUBSCRIBED")
                .message("Live subscription active for " + tokens.size() + " instrument(s)")
                .build();
    }

    /**
     * Removes the given instruments from an active subscription.
     * The WebSocket connection stays open for potential re-subscription.
     */
    public SubscriptionResponse unsubscribe(UnsubscribeRequest request) {
        String sessionKey = sessionKey(request.getUserId(), request.getBrokerName());
        MarketDataAdapter adapter = activeSessions.get(sessionKey);

        if (adapter == null || !adapter.isConnected()) {
            return SubscriptionResponse.builder()
                    .sessionKey(sessionKey)
                    .status("NOT_CONNECTED")
                    .message("No active session found for " + sessionKey)
                    .build();
        }

        adapter.unsubscribe(request.getInstrumentTokens());
        log.info("Unsubscribed session={}, tokens={}", sessionKey, request.getInstrumentTokens());

        return SubscriptionResponse.builder()
                .sessionKey(sessionKey)
                .brokerName(request.getBrokerName())
                .unsubscribedTokens(request.getInstrumentTokens())
                .status("UNSUBSCRIBED")
                .message("Removed " + request.getInstrumentTokens().size() + " instrument(s)")
                .build();
    }

    /**
     * Disconnects and removes the session entirely for (userId, brokerName).
     */
    public void disconnect(String userId, String brokerName) {
        String sessionKey = sessionKey(userId, brokerName);
        MarketDataAdapter adapter = activeSessions.remove(sessionKey);
        if (adapter != null) {
            adapter.disconnect();
            log.info("Disconnected session: {}", sessionKey);
        }
    }

    public boolean isConnected(String userId, String brokerName) {
        MarketDataAdapter adapter = activeSessions.get(sessionKey(userId, brokerName));
        return adapter != null && adapter.isConnected();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static String sessionKey(String userId, String brokerName) {
        return userId + "::" + brokerName.toLowerCase();
    }
}
