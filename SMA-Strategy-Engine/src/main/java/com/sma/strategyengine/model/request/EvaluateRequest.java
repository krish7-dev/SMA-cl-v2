package com.sma.strategyengine.model.request;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Feed one OHLCV candle into the strategy engine.
 *
 * The engine finds all ACTIVE strategy instances subscribed to the given
 * symbol + exchange and evaluates each one against this candle.
 *
 * Typically called by:
 *   - Data Engine (via HTTP webhook) on each completed live candle
 *   - Data Engine replay loop for backtesting
 *   - Direct API calls for manual testing
 */
@Data
public class EvaluateRequest {

    @NotBlank(message = "symbol is required")
    private String symbol;

    @NotBlank(message = "exchange is required")
    private String exchange;

    @NotNull(message = "candle is required")
    @Valid
    private CandleDto candle;

    @Data
    public static class CandleDto {

        private Instant    openTime;

        @NotNull(message = "candle.open is required")
        private BigDecimal open;

        @NotNull(message = "candle.high is required")
        private BigDecimal high;

        @NotNull(message = "candle.low is required")
        private BigDecimal low;

        @NotNull(message = "candle.close is required")
        private BigDecimal close;

        private long volume;
    }
}
