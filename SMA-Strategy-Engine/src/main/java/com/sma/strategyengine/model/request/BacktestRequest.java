package com.sma.strategyengine.model.request;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * Request to run one or more strategies against historical candle data.
 *
 * Multiple strategy configurations can be compared in a single call — the
 * response contains metrics for each so performance can be compared side by side.
 */
@Data
public class BacktestRequest {

    @NotBlank(message = "userId is required")
    private String userId;

    @NotBlank(message = "brokerName is required")
    private String brokerName;

    @NotBlank(message = "symbol is required")
    private String symbol;

    @NotBlank(message = "exchange is required")
    private String exchange;

    /**
     * Numeric Kite instrument token (e.g. 738561 for RELIANCE NSE).
     * Required so Data Engine can call the broker historical data API.
     */
    @NotNull(message = "instrumentToken is required")
    private Long instrumentToken;

    /**
     * Candle interval as enum NAME: MINUTE_1, MINUTE_3, MINUTE_5, MINUTE_10,
     * MINUTE_15, MINUTE_30, MINUTE_60, DAY, WEEK, MONTH.
     */
    @NotBlank(message = "interval is required")
    private String interval;

    /** Range start in exchange local time (IST). */
    @NotNull(message = "fromDate is required")
    private LocalDateTime fromDate;

    /** Range end in exchange local time (IST). */
    @NotNull(message = "toDate is required")
    private LocalDateTime toDate;

    /** Product type forwarded to order intent: MIS / CNC / NRML. */
    private String product = "MIS";

    /**
     * Number of units per trade signal.
     * 0 = auto-compute: floor(initialCapital / firstCandleClose) — max units the capital can buy.
     */
    @Min(value = 0, message = "quantity must be 0 (auto) or a positive integer")
    private int quantity = 0;

    /** Starting capital for PnL and drawdown calculations. */
    @NotNull
    @DecimalMin(value = "1", message = "initialCapital must be positive")
    private BigDecimal initialCapital = BigDecimal.valueOf(100_000);

    /** One or more strategy configurations to compare. */
    @NotEmpty(message = "at least one strategy configuration is required")
    @Valid
    private List<StrategyConfig> strategies;

    // ─── Nested types ─────────────────────────────────────────────────────────

    @Data
    public static class StrategyConfig {

        @NotBlank(message = "strategyType is required")
        private String strategyType;

        /** Optional human-readable label shown in results. Auto-generated if blank. */
        private String label;

        /** Strategy-specific parameters (e.g. {"shortPeriod":"5","longPeriod":"20"}). */
        private Map<String, String> parameters;
    }
}
