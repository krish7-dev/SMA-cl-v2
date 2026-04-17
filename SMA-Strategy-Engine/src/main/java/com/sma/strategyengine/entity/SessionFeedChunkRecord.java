package com.sma.strategyengine.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * One incremental chunk of candle-event JSON flushed during a live session.
 * Replaces the JSONB-append pattern on session_result.feed_json which became
 * progressively slower (13-110 s by end-of-day) as the document grew.
 *
 * Each row is a JSON array string, e.g. [{...},{...}].
 * Read path assembles the full feed by ordering rows by id ASC.
 */
@Entity
@Table(name = "session_feed_chunk")
@Data @Builder @NoArgsConstructor @AllArgsConstructor
public class SessionFeedChunkRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id")
    private Long id;

    @Column(name = "session_id", length = 100, nullable = false)
    private String sessionId;

    /** JSON array of OptionsReplayCandleEvent objects for this flush window. */
    @Column(name = "chunk_json", columnDefinition = "TEXT", nullable = false)
    private String chunkJson;

    @Column(name = "saved_at", nullable = false)
    private Instant savedAt;
}
