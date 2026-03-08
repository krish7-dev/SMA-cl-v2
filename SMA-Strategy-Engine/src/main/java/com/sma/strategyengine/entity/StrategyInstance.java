package com.sma.strategyengine.entity;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

/**
 * Persisted strategy instance — a configured, deployable unit of strategy logic.
 *
 * One instance = one strategy type + one instrument + one user account.
 * Multiple instances of the same strategy type can run on different symbols.
 *
 * Parameters (shortPeriod, longPeriod, etc.) are stored as a JSON string so the
 * schema stays stable regardless of which strategy type is used.
 */
@Entity
@Table(name = "strategy_instance")
@Getter @Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class StrategyInstance {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Stable public identifier (UUID). Exposed in API responses. */
    @Column(name = "instance_id", unique = true, nullable = false)
    private String instanceId;

    @Column(nullable = false)
    private String name;

    /** Matches a registered StrategyLogic.type() key, e.g. "SMA_CROSSOVER". */
    @Column(name = "strategy_type", nullable = false)
    private String strategyType;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "broker_name", nullable = false)
    private String brokerName;

    @Column(nullable = false)
    private String symbol;

    @Column(nullable = false)
    private String exchange;

    /** Product type forwarded to Execution Engine: MIS / CNC / NRML. */
    @Column(nullable = false)
    private String product;

    /** Default order quantity forwarded to Execution Engine. */
    @Column(nullable = false)
    private Integer quantity;

    /** Order type forwarded to Execution Engine: MARKET / LIMIT. */
    @Column(name = "order_type", nullable = false)
    private String orderType;

    /**
     * Strategy-specific parameters serialised as JSON.
     * Example for SMA_CROSSOVER: {"shortPeriod":"5","longPeriod":"20"}
     */
    @Column(columnDefinition = "TEXT")
    private String parameters;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status;

    @Column(name = "created_at", nullable = false, updatable = false)
    @Builder.Default
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    @Builder.Default
    private Instant updatedAt = Instant.now();

    @PreUpdate
    void onUpdate() { this.updatedAt = Instant.now(); }

    // ─── Enums ────────────────────────────────────────────────────────────────

    public enum Status {
        /** Actively evaluating market data and generating signals. */
        ACTIVE,
        /** Paused — no signals will be generated. */
        INACTIVE,
        /** Stopped due to an unrecoverable error. */
        ERROR
    }
}
