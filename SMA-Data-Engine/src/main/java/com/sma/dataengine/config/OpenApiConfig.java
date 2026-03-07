package com.sma.dataengine.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI dataEngineOpenAPI() {
        return new OpenAPI()
                .info(new Info()
                        .title("SMA Data Engine API")
                        .description("Live ticks, historical candles, replay, and normalized market data feeds")
                        .version("0.0.1")
                        .contact(new Contact().name("SMA Platform")));
    }
}
