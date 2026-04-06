package com.sma.strategyengine;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class StrategyEngineApplication {

    public static void main(String[] args) {
        SpringApplication.run(StrategyEngineApplication.class, args);
    }
}
