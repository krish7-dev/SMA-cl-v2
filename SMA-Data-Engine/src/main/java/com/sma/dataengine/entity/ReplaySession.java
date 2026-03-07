package com.sma.dataengine.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.time.LocalDateTime;

/**
 * Tracks the lifecycle of a historical data replay session.
 * One session = one instrument, one interval, one time range replayed at a given speed.
 */
@Entity
@Table(
    name = "replay_session",
    indexes = {
        @Index(name = "idx_replay_session_id", columnList = "session_id"),
        @Index(name = "idx_replay_status",     columnList = "status"),
        @Index(name = "idx_replay_user",       columnList = "requested_by")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ReplaySession {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** UUID assigned at session creation — used as the external session handle. */
    @Column(name = "session_id", nullable = false, unique = true, length = 36)
    private String sessionId;

    @Column(name = "instrument_token", nullable = false)
    private Long instrumentToken;

    @Column(name = "symbol", length = 100)
    private String symbol;

    @Column(name = "exchange", length = 20)
    private String exchange;

    @Column(name = "interval", nullable = false, length = 20)
    private String interval;

    @Column(name = "from_time", nullable = false)
    private LocalDateTime fromTime;

    @Column(name = "to_time", nullable = false)
    private LocalDateTime toTime;

    /** Number of candles emitted per second. */
    @Column(name = "speed_multiplier", nullable = false)
    @Builder.Default
    private int speedMultiplier = 1;

    @Column(name = "total_candles")
    private Integer totalCandles;

    @Column(name = "emitted_candles")
    @Builder.Default
    private Integer emittedCandles = 0;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    @Builder.Default
    private Status status = Status.PENDING;

    @Column(name = "requested_by", length = 100)
    private String requestedBy;

    @Column(name = "provider", length = 50)
    private String provider;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public enum Status {
        PENDING,
        RUNNING,
        COMPLETED,
        STOPPED,
        FAILED
    }
}
