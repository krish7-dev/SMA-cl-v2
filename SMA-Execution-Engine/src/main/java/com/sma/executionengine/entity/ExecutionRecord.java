package com.sma.executionengine.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.UpdateTimestamp;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Persists the full lifecycle of an order intent.
 *
 * intentId is the caller-supplied idempotency key — one ExecutionRecord
 * exists per unique intent regardless of how many retries are attempted.
 */
@Entity
@Table(
    name = "execution_record",
    indexes = {
        @Index(name = "idx_exec_user_broker",  columnList = "user_id, broker_name"),
        @Index(name = "idx_exec_status",       columnList = "status"),
        @Index(name = "idx_exec_broker_order", columnList = "broker_order_id")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ExecutionRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Caller-supplied idempotency key — unique per intent. */
    @Column(name = "intent_id", nullable = false, unique = true, length = 100)
    private String intentId;

    /** clientOrderId forwarded to Broker Engine for its own idempotency. */
    @Column(name = "broker_client_order_id", length = 100)
    private String brokerClientOrderId;

    /** Broker's order ID returned after successful placement. */
    @Column(name = "broker_order_id", length = 100)
    private String brokerOrderId;

    @Column(name = "user_id", nullable = false, length = 100)
    private String userId;

    @Column(name = "broker_name", nullable = false, length = 50)
    private String brokerName;

    @Column(name = "symbol", nullable = false, length = 50)
    private String symbol;

    @Column(name = "exchange", nullable = false, length = 20)
    private String exchange;

    @Enumerated(EnumType.STRING)
    @Column(name = "side", nullable = false, length = 10)
    private Side side;

    @Enumerated(EnumType.STRING)
    @Column(name = "order_type", nullable = false, length = 20)
    private OrderType orderType;

    @Enumerated(EnumType.STRING)
    @Column(name = "product", nullable = false, length = 20)
    private Product product;

    @Column(name = "quantity", nullable = false)
    private Integer quantity;

    @Column(name = "price", precision = 18, scale = 4)
    private BigDecimal price;

    @Column(name = "trigger_price", precision = 18, scale = 4)
    private BigDecimal triggerPrice;

    @Column(name = "validity", length = 10)
    private String validity;

    @Column(name = "tag", length = 100)
    private String tag;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 30)
    @Builder.Default
    private Status status = Status.PENDING;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;

    @Column(name = "created_at", nullable = false, updatable = false)
    @Builder.Default
    private Instant createdAt = Instant.now();

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    // ─── Enums ────────────────────────────────────────────────────────────────

    public enum Side {
        BUY, SELL
    }

    public enum OrderType {
        MARKET, LIMIT, SL, SL_M
    }

    public enum Product {
        CNC, MIS, NRML
    }

    /**
     * Execution lifecycle statuses.
     *
     * PENDING   — record created, validation not yet run
     * SUBMITTED — passed validation + risk; submitted to Broker Engine
     * FILLED    — broker confirmed full fill
     * REJECTED  — broker rejected the order
     * CANCELLED — order was cancelled after submission
     * FAILED    — internal error during processing
     */
    public enum Status {
        PENDING,
        SUBMITTED,
        FILLED,
        REJECTED,
        CANCELLED,
        FAILED
    }
}
