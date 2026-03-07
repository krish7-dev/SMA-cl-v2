package com.sma.brokerengine.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI brokerEngineOpenAPI() {
        return new OpenAPI()
                .info(new Info()
                        .title("SMA Broker Engine API")
                        .description("Broker authentication, session management, order placement, positions, and margins")
                        .version("0.0.1")
                        .contact(new Contact().name("SMA Platform")));
    }
}
