package com.sma.aiengine.entity;

import com.sma.aiengine.model.enums.AiSource;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.List;

@Entity
@Table(
    name = "market_context_record",
    indexes = {
        @Index(name = "idx_mctx_session",    columnList = "session_id"),
        @Index(name = "idx_mctx_candle",     columnList = "candle_time"),
        @Index(name = "idx_mctx_request_id", columnList = "request_id")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class MarketContextRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "session_id", nullable = false, length = 100)
    private String sessionId;

    @Column(name = "candle_time", nullable = false)
    private Instant candleTime;

    @Column(name = "regime", length = 50)
    private String regime;

    @Column(name = "market_tradable")
    private Boolean marketTradable;

    @Column(name = "avoid_ce")
    private Boolean avoidCe;

    @Column(name = "avoid_pe")
    private Boolean avoidPe;

    @Column(name = "confidence")
    private Double confidence;

    @Column(name = "summary", columnDefinition = "TEXT")
    private String summary;

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

    @Column(name = "request_id", length = 100)
    private String requestId;

    @Column(name = "ai_model", length = 100)
    private String aiModel;

    @Column(name = "ai_prompt_mode", length = 20)
    private String aiPromptMode;

    @Column(name = "created_at", nullable = false, updatable = false)
    @Builder.Default
    private Instant createdAt = Instant.now();
}
