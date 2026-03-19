package com.sma.strategyengine.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Entity
@Table(name = "live_session_snapshot",
       uniqueConstraints = @UniqueConstraint(columnNames = {"user_id","broker_name"}))
@Data @Builder @NoArgsConstructor @AllArgsConstructor
public class LiveSnapshotRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id",     nullable = false, length = 100)
    private String userId;

    @Column(name = "broker_name", nullable = false, length = 50)
    private String brokerName;

    @Column(name = "session_id",  length = 100)
    private String sessionId;

    @Column(name = "saved_at",    nullable = false)
    private Instant savedAt;

    @Column(name = "state_json",  nullable = false, columnDefinition = "TEXT")
    private String stateJson;
}
