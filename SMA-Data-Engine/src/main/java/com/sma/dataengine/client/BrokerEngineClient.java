package com.sma.dataengine.client;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.Map;

/**
 * HTTP client for SMA-Broker-Engine.
 *
 * Used by Data Engine services to resolve broker credentials
 * (apiKey + accessToken) without requiring the caller to pass them
 * explicitly in every request.
 */
@Slf4j
@Component
public class BrokerEngineClient {

    private final RestTemplate restTemplate;
    private final String baseUrl;

    public BrokerEngineClient(
            RestTemplateBuilder builder,
            @Value("${data.broker-engine.base-url:http://localhost:9003}") String baseUrl) {
        this.restTemplate = builder.build();
        this.baseUrl = baseUrl;
    }

    public record Credentials(String apiKey, String accessToken) {
        public boolean isComplete() {
            return apiKey != null && !apiKey.isBlank()
                    && accessToken != null && !accessToken.isBlank();
        }
    }

    /**
     * Fetches decrypted apiKey + accessToken from Broker Engine for the given user/broker.
     * Returns {@code Credentials(null, null)} on any error so callers can handle gracefully.
     */
    @SuppressWarnings("unchecked")
    public Credentials fetchCredentials(String userId, String brokerName) {
        try {
            String url = UriComponentsBuilder
                    .fromHttpUrl(baseUrl + "/api/v1/broker/auth/credentials")
                    .queryParam("userId", userId)
                    .queryParam("brokerName", brokerName)
                    .toUriString();

            Map<String, Object> response = restTemplate.getForObject(url, Map.class);
            if (response != null && response.get("data") instanceof Map<?, ?> data) {
                String apiKey      = (String) data.get("apiKey");
                String accessToken = (String) data.get("accessToken");
                log.debug("Resolved credentials from Broker Engine for userId={}, broker={}", userId, brokerName);
                return new Credentials(apiKey, accessToken);
            }
        } catch (Exception e) {
            log.warn("Could not fetch credentials from Broker Engine for userId={}, broker={}: {}",
                    userId, brokerName, e.getMessage());
        }
        return new Credentials(null, null);
    }
}
