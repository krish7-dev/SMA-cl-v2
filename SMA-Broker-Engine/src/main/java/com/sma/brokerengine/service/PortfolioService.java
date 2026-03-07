package com.sma.brokerengine.service;

import com.sma.brokerengine.adapter.BrokerAdapter;
import com.sma.brokerengine.adapter.BrokerAdapterRegistry;
import com.sma.brokerengine.model.response.MarginResponse;
import com.sma.brokerengine.model.response.PositionResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class PortfolioService {

    private final BrokerAdapterRegistry adapterRegistry;
    private final BrokerAuthService authService;

    public List<PositionResponse> getPositions(String userId, String brokerName) {
        BrokerAdapter adapter = adapterRegistry.resolve(brokerName);
        String accessToken = authService.resolveAccessToken(userId, brokerName);
        String apiKey = authService.resolveApiKey(userId, brokerName);
        log.info("Fetching positions: userId={}, broker={}", userId, brokerName);
        return adapter.getPositions(accessToken, apiKey);
    }

    public List<MarginResponse> getMargins(String userId, String brokerName) {
        BrokerAdapter adapter = adapterRegistry.resolve(brokerName);
        String accessToken = authService.resolveAccessToken(userId, brokerName);
        String apiKey = authService.resolveApiKey(userId, brokerName);
        log.info("Fetching margins: userId={}, broker={}", userId, brokerName);
        return adapter.getMargins(accessToken, apiKey);
    }
}
