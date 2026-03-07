package com.sma.executionengine.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI executionEngineOpenAPI() {
        return new OpenAPI()
                .info(new Info()
                        .title("SMA Execution Engine API")
                        .description("Execution orchestration, risk checks, and order routing")
                        .version("0.0.1")
                        .contact(new Contact().name("SMA Platform")));
    }
}
