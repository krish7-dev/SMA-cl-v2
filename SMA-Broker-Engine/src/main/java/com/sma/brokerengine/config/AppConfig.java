package com.sma.brokerengine.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(EncryptionConfig.class)
public class AppConfig {
    // Central configuration hook — additional beans can be registered here as the platform grows.
}
