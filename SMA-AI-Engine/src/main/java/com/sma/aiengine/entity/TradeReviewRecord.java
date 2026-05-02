package com.sma.aiengine.entity;

import com.sma.aiengine.model.enums.AiSource;
import com.sma.aiengine.model.enums.MistakeType;
import com.sma.aiengine.model.enums.TradeQuality;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

@Entity
@Table(
    name = "trade_review_record",
    uniqueConstraints = {
        @UniqueConstraint(name = "uq_rev_session_trade", columnNames = {"session_id", "trade_id"})
    },
    indexes = {
        @Index(name = "idx_rev_session",       columnList = "session_id"),
        @Index(name = "idx_rev_symbol",        columnList = "symbol"),
        @Index(name = "idx_rev_session_trade", columnList = "session_id, trade_id")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TradeReviewRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "trade_id", nullable = false, length = 100)
    private String tradeId;

    @Column(name = "session_id", length = 100)
    private String sessionId;

    @Column(name = "symbol", length = 50)
    private String symbol;

    @Column(name = "side", length = 20)
    private String side;

    @Column(name = "regime", length = 50)
    private String regime;

    @Column(name = "entry_time")
    private Instant entryTime;

    @Column(name = "exit_time")
    private Instant exitTime;

    @Column(name = "pnl", precision = 18, scale = 4)
    private BigDecimal pnl;

    @Column(name = "pnl_pct")
    private Double pnlPct;

    @Column(name = "exit_reason", length = 100)
    private String exitReason;

    @Enumerated(EnumType.STRING)
    @Column(name = "quality", nullable = false, length = 20)
    @Builder.Default
    private TradeQuality quality = TradeQuality.UNKNOWN;

    @Column(name = "avoidable")
    private Boolean avoidable;

    @Enumerated(EnumType.STRING)
    @Column(name = "mistake_type", length = 50)
    @Builder.Default
    private MistakeType mistakeType = MistakeType.UNKNOWN;

    @Column(name = "confidence")
    private Double confidence;

    @Column(name = "summary", columnDefinition = "TEXT")
    private String summary;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "what_worked", columnDefinition = "jsonb")
    private List<String> whatWorked;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "what_failed", columnDefinition = "jsonb")
    private List<String> whatFailed;

    @Column(name = "suggested_rule", columnDefinition = "TEXT")
    private String suggestedRule;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "reason_codes", columnDefinition = "jsonb")
    private List<String> reasonCodes;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "warning_codes", columnDefinition = "jsonb")
    private List<String> warningCodes;

    @Enumerated(EnumType.STRING)
    @Column(name = "source", nullable = false, length = 20)
    private AiSource source;

    @Column(name = "latency_ms")
    private Long latencyMs;

    @Column(name = "request_json", columnDefinition = "TEXT")
    private String requestJson;

    @Column(name = "response_json", columnDefinition = "TEXT")
    private String responseJson;

    @Column(name = "error_details", columnDefinition = "TEXT")
    private String errorDetails;

    @Column(name = "request_id", length = 100)
    private String requestId;

    @Column(name = "created_at", nullable = false, updatable = false)
    @Builder.Default
    private Instant createdAt = Instant.now();
}
