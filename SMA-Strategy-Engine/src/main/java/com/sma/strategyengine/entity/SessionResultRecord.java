package com.sma.strategyengine.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.time.LocalDate;

@Entity
@Table(name = "session_result")
@Data @Builder @NoArgsConstructor @AllArgsConstructor
public class SessionResultRecord {

    @Id
    @Column(name = "session_id", length = 100)
    private String sessionId;

    /** "LIVE" or "TICK_REPLAY" */
    @Column(name = "type", nullable = false, length = 20)
    private String type;

    @Column(name = "user_id", length = 100)
    private String userId;

    @Column(name = "broker_name", length = 50)
    private String brokerName;

    @Column(name = "session_date")
    private LocalDate sessionDate;

    @Column(name = "label", length = 200)
    private String label;

    /** Serialised request config (OptionsLiveRequest or TickOptionsReplayRequest). */
    @Column(name = "config_json", columnDefinition = "TEXT")
    private String configJson;

    /** JSON array of ClosedTrade objects. */
    @Column(name = "closed_trades_json", columnDefinition = "TEXT")
    private String closedTradesJson;

    /** JSON array of OptionsReplayCandleEvent (full per-candle feed). */
    @Column(name = "feed_json", columnDefinition = "TEXT")
    private String feedJson;

    /** Pre-computed summary stats: trades, realizedPnl, winRate, finalCapital. */
    @Column(name = "summary_json", columnDefinition = "TEXT")
    private String summaryJson;

    @Column(name = "saved_at", nullable = false)
    private Instant savedAt;
}
