package com.sma.dataengine;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * SMA Data Engine — responsible exclusively for market data concerns:
 * live tick ingestion, historical candle retrieval, and replay workflows.
 *
 * Boundary: This service does NOT handle broker auth, order placement,
 * cancellation, portfolio, or margin logic. Those belong to SMA-Broker-Engine.
 */
@SpringBootApplication
@EnableScheduling
public class DataEngineApplication {

    public static void main(String[] args) {
        SpringApplication.run(DataEngineApplication.class, args);
    }
}
