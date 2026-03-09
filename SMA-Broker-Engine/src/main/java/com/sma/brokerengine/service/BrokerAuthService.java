package com.sma.brokerengine.service;

import com.sma.brokerengine.adapter.BrokerAdapter;
import com.sma.brokerengine.adapter.BrokerAdapterRegistry;
import com.sma.brokerengine.entity.BrokerAccount;
import com.sma.brokerengine.model.request.BrokerAuthRequest;
import com.sma.brokerengine.model.response.BrokerAuthResponse;
import com.sma.brokerengine.repository.BrokerAccountRepository;
import com.sma.brokerengine.security.TokenEncryptionService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class BrokerAuthService {

    private final BrokerAccountRepository brokerAccountRepository;
    private final BrokerAdapterRegistry adapterRegistry;
    private final TokenEncryptionService encryptionService;

    /**
     * Registers or updates a broker account and exchanges the request token
     * for a live access token from the broker.
     */
    @Transactional
    public BrokerAuthResponse authenticateAndStoreToken(BrokerAuthRequest request) {
        BrokerAdapter adapter = adapterRegistry.resolve(request.getBrokerName());

        String accessToken = adapter.generateAccessToken(
                request.getApiKey(),
                request.getApiSecret(),
                request.getRequestToken()
        );

        BrokerAccount account = brokerAccountRepository
                .findByUserIdAndBrokerName(request.getUserId(), request.getBrokerName())
                .orElseGet(BrokerAccount::new);

        account.setUserId(request.getUserId());
        account.setBrokerName(request.getBrokerName());
        account.setClientId(request.getClientId());
        account.setApiKeyEncrypted(encryptionService.encrypt(request.getApiKey()));
        account.setApiSecretEncrypted(encryptionService.encrypt(request.getApiSecret()));
        account.setAccessTokenEncrypted(encryptionService.encrypt(accessToken));
        account.setTokenExpiry(Instant.now().plus(1, ChronoUnit.DAYS));
        account.setStatus(BrokerAccount.AccountStatus.ACTIVE);

        account = brokerAccountRepository.save(account);
        log.info("Broker account authenticated: userId={}, broker={}", request.getUserId(), request.getBrokerName());

        return BrokerAuthResponse.builder()
                .accountId(account.getId())
                .userId(account.getUserId())
                .brokerName(account.getBrokerName())
                .clientId(account.getClientId())
                .status(account.getStatus().name())
                .tokenExpiry(account.getTokenExpiry())
                .message("Authentication successful")
                .apiKey(request.getApiKey())
                .accessToken(accessToken)
                .build();
    }

    /**
     * Invalidates the stored access token and marks the account inactive.
     */
    @Transactional
    public void logout(String userId, String brokerName) {
        brokerAccountRepository.findByUserIdAndBrokerName(userId, brokerName)
                .ifPresent(account -> {
                    account.setAccessTokenEncrypted(null);
                    account.setTokenExpiry(null);
                    account.setStatus(BrokerAccount.AccountStatus.INACTIVE);
                    brokerAccountRepository.save(account);
                    log.info("Broker account logged out: userId={}, broker={}", userId, brokerName);
                });
    }

    /**
     * Resolves and decrypts the access token for an active account.
     * Used internally by other services — not exposed via API.
     */
    public String resolveAccessToken(String userId, String brokerName) {
        BrokerAccount account = brokerAccountRepository
                .findByUserIdAndBrokerName(userId, brokerName)
                .orElseThrow(() -> new AccountNotFoundException(
                        "No broker account found for userId=" + userId + ", broker=" + brokerName));

        if (account.getStatus() != BrokerAccount.AccountStatus.ACTIVE) {
            throw new TokenNotAvailableException("Broker account is not active: " + account.getStatus());
        }
        if (account.getTokenExpiry() != null && Instant.now().isAfter(account.getTokenExpiry())) {
            throw new TokenNotAvailableException("Access token has expired for userId=" + userId);
        }

        return encryptionService.decrypt(account.getAccessTokenEncrypted());
    }

    /**
     * Returns all broker accounts, optionally filtered by userId.
     * Sensitive fields (tokens, secrets) are never included.
     */
    public List<BrokerAuthResponse> listAccounts(String userId) {
        List<BrokerAccount> accounts = (userId != null && !userId.isBlank())
                ? brokerAccountRepository.findAllByUserId(userId)
                : brokerAccountRepository.findAll();
        return accounts.stream().map(this::toResponse).collect(Collectors.toList());
    }

    private BrokerAuthResponse toResponse(BrokerAccount account) {
        return BrokerAuthResponse.builder()
                .accountId(account.getId())
                .userId(account.getUserId())
                .brokerName(account.getBrokerName())
                .clientId(account.getClientId())
                .status(account.getStatus().name())
                .tokenExpiry(account.getTokenExpiry())
                .build();
    }

    /**
     * Returns decrypted apiKey + accessToken for the UI session restore flow.
     */
    public BrokerAuthResponse getCredentials(String userId, String brokerName) {
        BrokerAccount account = brokerAccountRepository
                .findByUserIdAndBrokerName(userId, brokerName)
                .orElseThrow(() -> new AccountNotFoundException(
                        "No broker account found for userId=" + userId + ", broker=" + brokerName));
        return BrokerAuthResponse.builder()
                .accountId(account.getId())
                .userId(account.getUserId())
                .brokerName(account.getBrokerName())
                .clientId(account.getClientId())
                .status(account.getStatus().name())
                .tokenExpiry(account.getTokenExpiry())
                .apiKey(encryptionService.decrypt(account.getApiKeyEncrypted()))
                .apiSecret(encryptionService.decrypt(account.getApiSecretEncrypted()))
                .accessToken(account.getAccessTokenEncrypted() != null
                        ? encryptionService.decrypt(account.getAccessTokenEncrypted()) : null)
                .build();
    }

    public String resolveApiKey(String userId, String brokerName) {
        BrokerAccount account = brokerAccountRepository
                .findByUserIdAndBrokerName(userId, brokerName)
                .orElseThrow(() -> new AccountNotFoundException(
                        "No broker account found for userId=" + userId + ", broker=" + brokerName));
        return encryptionService.decrypt(account.getApiKeyEncrypted());
    }

    // ------------------------------------------------------------------
    // Exceptions
    // ------------------------------------------------------------------

    public static class AccountNotFoundException extends RuntimeException {
        public AccountNotFoundException(String message) { super(message); }
    }

    public static class TokenNotAvailableException extends RuntimeException {
        public TokenNotAvailableException(String message) { super(message); }
    }
}
