package com.sma.strategyengine.controller;

import org.springframework.boot.info.BuildProperties;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/strategy")
public class HealthController {

    private final BuildProperties buildProperties;

    public HealthController(BuildProperties buildProperties) {
        this.buildProperties = buildProperties;
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        return ResponseEntity.ok(Map.of(
                "service", "SMA-Strategy-Engine",
                "status", "UP",
                "timestamp", Instant.now().toString()
        ));
    }

    @GetMapping("/version")
    public ResponseEntity<Map<String, Object>> version() {
        return ResponseEntity.ok(Map.of(
                "service", buildProperties.getName(),
                "version", buildProperties.getVersion(),
                "buildTime", buildProperties.getTime().toString()
        ));
    }
}
