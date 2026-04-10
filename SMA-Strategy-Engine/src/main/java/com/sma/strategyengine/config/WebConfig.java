package com.sma.strategyengine.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Global CORS configuration.
 * Allowed origins are read from {@code cors.allowed-origins} (env: CORS_ALLOWED_ORIGINS).
 * Dev default: localhost:3000,localhost:5173
 * Production: set CORS_ALLOWED_ORIGINS=https://yourapp.vercel.app
 */
@Configuration(proxyBeanMethods = false)
public class WebConfig implements WebMvcConfigurer {

    @Value("${cors.allowed-origins:http://localhost:3000,http://localhost:5173}")
    private String rawAllowedOrigins;

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        String[] origins = rawAllowedOrigins.split(",");

        registry.addMapping("/api/**")
                .allowedOrigins(origins)
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);

        registry.addMapping("/actuator/**")
                .allowedOrigins(origins)
                .allowedMethods("GET")
                .allowedHeaders("*")
                .maxAge(3600);
    }
}
