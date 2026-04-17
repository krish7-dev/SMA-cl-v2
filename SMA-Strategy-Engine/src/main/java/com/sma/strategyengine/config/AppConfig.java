package com.sma.strategyengine.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration(proxyBeanMethods = false)
public class AppConfig {

    @Bean
    public ObjectMapper objectMapper() {
        return new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    /**
     * Multi-threaded scheduler so the 15 s heartbeat/flushFeed tasks can never block
     * the market-close autoFinalSave cron (or any other scheduled task).
     * Spring's default is a single-threaded scheduler — one blocked DB call prevents
     * all other scheduled tasks from firing until it completes or times out.
     */
    @Bean
    public ThreadPoolTaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(4);
        scheduler.setThreadNamePrefix("sched-");
        scheduler.setDaemon(true);
        scheduler.setWaitForTasksToCompleteOnShutdown(false);
        return scheduler;
    }
}
