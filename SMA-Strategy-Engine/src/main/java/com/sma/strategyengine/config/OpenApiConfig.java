package com.sma.strategyengine.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class OpenApiConfig {

    @Bean
    OpenAPI strategyEngineOpenAPI() {
        return new OpenAPI()
                .info(new Info()
                        .title("SMA Strategy Engine API")
                        .description("Signal generation, strategy evaluation, and order intent publishing")
                        .version("0.0.1")
                        .contact(new Contact().name("SMA Platform")));
    }
}
