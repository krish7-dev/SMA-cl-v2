package com.sma.dataengine.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;

/**
 * Persisted OHLCV candle bar.
 * Populated by HistoricalDataService after fetching from a broker adapter.
 * Used as the source for replay sessions.
 */
@Entity
@Table(
    name = "candle_data",
    uniqueConstraints = @UniqueConstraint(
        name  = "uq_candle_token_interval_time_provider",
        columnNames = {"instrument_token", "interval", "open_time", "provider"}
    ),
    indexes = {
        @Index(name = "idx_candle_token_interval_time", columnList = "instrument_token, interval, open_time"),
        @Index(name = "idx_candle_symbol",              columnList = "symbol, exchange, interval")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CandleRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "instrument_token", nullable = false)
    private Long instrumentToken;

    @Column(name = "symbol", length = 100)
    private String symbol;

    @Column(name = "exchange", length = 20)
    private String exchange;

    /** Stored as the normalized string (e.g. "minute", "day"). */
    @Column(name = "interval", nullable = false, length = 20)
    private String interval;

    /** Candle open time in UTC. */
    @Column(name = "open_time", nullable = false)
    private LocalDateTime openTime;

    @Column(name = "open", nullable = false, precision = 18, scale = 4)
    private BigDecimal open;

    @Column(name = "high", nullable = false, precision = 18, scale = 4)
    private BigDecimal high;

    @Column(name = "low", nullable = false, precision = 18, scale = 4)
    private BigDecimal low;

    @Column(name = "close", nullable = false, precision = 18, scale = 4)
    private BigDecimal close;

    @Column(name = "volume", nullable = false)
    @Builder.Default
    private Long volume = 0L;

    @Column(name = "open_interest", nullable = false)
    @Builder.Default
    private Long openInterest = 0L;

    /** Data provider identifier (e.g. "kite"). */
    @Column(name = "provider", nullable = false, length = 50)
    private String provider;

    @CreationTimestamp
    @Column(name = "fetched_at", nullable = false, updatable = false)
    private Instant fetchedAt;
}
