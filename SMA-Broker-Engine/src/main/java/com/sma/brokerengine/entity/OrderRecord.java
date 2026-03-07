package com.sma.brokerengine.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Persists the full lifecycle of an order as seen by the Broker Engine.
 * clientOrderId ensures idempotent submission — duplicate requests with the same
 * clientOrderId will be rejected rather than double-submitted to the broker.
 */
@Entity
@Table(name = "order_record", indexes = {
        @Index(name = "idx_order_record_client_order_id", columnList = "client_order_id", unique = true),
        @Index(name = "idx_order_record_broker_account_id", columnList = "broker_account_id"),
        @Index(name = "idx_order_record_broker_order_id", columnList = "broker_order_id"),
        @Index(name = "idx_order_record_status", columnList = "status")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OrderRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /**
     * Platform-generated unique order ID — used for idempotency.
     */
    @Column(name = "client_order_id", nullable = false, unique = true, length = 100)
    private String clientOrderId;

    /**
     * Order ID returned by the broker after successful placement.
     */
    @Column(name = "broker_order_id", length = 100)
    private String brokerOrderId;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "broker_account_id", nullable = false)
    private BrokerAccount brokerAccount;

    @Column(name = "symbol", nullable = false, length = 50)
    private String symbol;

    @Column(name = "exchange", nullable = false, length = 20)
    private String exchange;

    @Enumerated(EnumType.STRING)
    @Column(name = "transaction_type", nullable = false, length = 10)
    private TransactionType transactionType;

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

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 30)
    private OrderStatus status;

    @Column(name = "status_message", columnDefinition = "TEXT")
    private String statusMessage;

    @Column(name = "filled_quantity")
    private Integer filledQuantity;

    @Column(name = "average_price", precision = 18, scale = 4)
    private BigDecimal averagePrice;

    @Column(name = "validity", length = 10)
    private String validity;

    @Column(name = "tag", length = 100)
    private String tag;

    @Column(name = "raw_broker_response", columnDefinition = "TEXT")
    private String rawBrokerResponse;

    @Column(name = "placed_at")
    private Instant placedAt;

    @Column(name = "updated_by_broker_at")
    private Instant updatedByBrokerAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public enum TransactionType {
        BUY, SELL
    }

    public enum OrderType {
        MARKET, LIMIT, SL, SL_M
    }

    public enum Product {
        CNC, MIS, NRML
    }

    public enum OrderStatus {
        PENDING,
        OPEN,
        COMPLETE,
        CANCELLED,
        REJECTED,
        TRIGGER_PENDING,
        AMO_REQ_RECEIVED
    }
}
