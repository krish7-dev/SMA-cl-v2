package com.sma.dataengine.model;

import jakarta.persistence.*;
import lombok.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;

@Entity
@Table(name = "tick_data")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TickRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "instrument_token", nullable = false)
    private Long instrumentToken;

    @Column(name = "symbol")
    private String symbol;

    @Column(name = "exchange")
    private String exchange;

    @Column(name = "ltp", nullable = false)
    private BigDecimal ltp;

    @Column(name = "volume")
    private Long volume;

    @Column(name = "tick_time", nullable = false)
    private LocalDateTime tickTime;

    @Column(name = "session_id", nullable = false)
    private String sessionId;

    @Column(name = "provider")
    private String provider;
}
