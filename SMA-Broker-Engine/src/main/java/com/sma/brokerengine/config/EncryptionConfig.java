package com.sma.brokerengine.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@ConfigurationProperties(prefix = "broker.encryption")
@Data
public class EncryptionConfig {

    private String secretKey;
    private String algorithm;
}
