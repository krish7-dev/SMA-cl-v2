package com.sma.brokerengine.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Fails fast at startup if critical configuration values are invalid.
 * Missing env vars (DB_URL, DB_USERNAME, DB_PASSWORD, ENCRYPTION_SECRET_KEY)
 * are already caught by Spring placeholder resolution before this runs.
 */
@Component
public class StartupValidator {

    private static final Logger log = LoggerFactory.getLogger(StartupValidator.class);

    private final EncryptionConfig encryptionConfig;

    public StartupValidator(EncryptionConfig encryptionConfig) {
        this.encryptionConfig = encryptionConfig;
    }

    @PostConstruct
    public void validate() {
        String key = encryptionConfig.getSecretKey();
        if (key == null || key.isBlank()) {
            throw new IllegalStateException(
                "[Broker Engine] ENCRYPTION_SECRET_KEY is blank. Set this env var to a 32+ character secret.");
        }
        if (key.length() < 32) {
            throw new IllegalStateException(
                "[Broker Engine] ENCRYPTION_SECRET_KEY is too short (" + key.length() +
                " chars). AES-256 requires at least 32 characters.");
        }
        log.info("[Broker Engine] Startup validation passed — encryption key length OK ({} chars)", key.length());
    }
}
