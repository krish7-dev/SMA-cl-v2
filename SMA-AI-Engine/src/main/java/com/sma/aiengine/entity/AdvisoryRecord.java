package com.sma.aiengine.entity;

import com.sma.aiengine.model.enums.AdvisoryAction;
import com.sma.aiengine.model.enums.AiSource;
import com.sma.aiengine.model.enums.RiskLevel;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.List;

@Entity
@Table(
    name = "advisory_record",
    indexes = {
        @Index(name = "idx_adv_session",    columnList = "session_id"),
        @Index(name = "idx_adv_symbol",     columnList = "symbol"),
        @Index(name = "idx_adv_action",     columnList = "action"),
        @Index(name = "idx_adv_request_id", columnList = "request_id")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class AdvisoryRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "session_id", nullable = false, length = 100)
    private String sessionId;

    @Column(name = "symbol", nullable = false, length = 50)
    private String symbol;

    @Column(name = "side", length = 10)
    private String side;

    @Column(name = "regime", length = 50)
    private String regime;

    @Column(name = "candle_time")
    private Instant candleTime;

    @Enumerated(EnumType.STRING)
    @Column(name = "action", nullable = false, length = 20)
    @Builder.Default
    private AdvisoryAction action = AdvisoryAction.UNKNOWN;

    @Column(name = "confidence")
    private Double confidence;

    @Column(name = "trade_quality_score")
    private Double tradeQualityScore;

    @Enumerated(EnumType.STRING)
    @Column(name = "risk_level", length = 20)
    @Builder.Default
    private RiskLevel riskLevel = RiskLevel.UNKNOWN;

    @Column(name = "reversal_risk")
    private Double reversalRisk;

    @Column(name = "chop_risk")
    private Double chopRisk;

    @Column(name = "late_entry_risk")
    private Double lateEntryRisk;

    @Column(name = "overextension_risk")
    private Double overextensionRisk;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "reason_codes", columnDefinition = "jsonb")
    private List<String> reasonCodes;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "warning_codes", columnDefinition = "jsonb")
    private List<String> warningCodes;

    @Column(name = "summary", columnDefinition = "TEXT")
    private String summary;

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
