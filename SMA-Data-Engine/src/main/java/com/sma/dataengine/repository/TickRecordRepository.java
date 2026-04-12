package com.sma.dataengine.repository;

import com.sma.dataengine.model.TickRecord;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface TickRecordRepository extends JpaRepository<TickRecord, Long> {

    /**
     * Fetches ticks for multiple tokens in one session, ordered by tick_time.
     * Uses a native query because JPQL does not support IN with List<Long> natively
     * across all JPA providers without extra configuration.
     */
    @Query(value = """
            SELECT * FROM tick_data
            WHERE session_id = :sessionId
              AND instrument_token IN (:tokens)
            ORDER BY tick_time ASC
            """, nativeQuery = true)
    List<TickRecord> findBySessionIdAndTokensOrdered(
            @Param("sessionId") String sessionId,
            @Param("tokens")    List<Long> tokens);

    /**
     * Fetches all ticks for a session (no token filter), ordered by tick_time.
     * Used when the caller wants all instruments for a session (e.g. compare tab).
     */
    @Query(value = """
            SELECT * FROM tick_data
            WHERE session_id = :sessionId
            ORDER BY tick_time ASC
            """, nativeQuery = true)
    List<TickRecord> findBySessionIdOrdered(@Param("sessionId") String sessionId);

    /**
     * Fetches ticks for a session within an inclusive date range, ordered by tick_time.
     * Used by the compare/UI path — callers pass LocalDateTime.MIN / LocalDateTime.MAX
     * for open-ended bounds rather than nulls, keeping the SQL simple and reliable.
     * Paged via Spring Data Pageable so the query cap is enforced in the DB (LIMIT/OFFSET).
     */
    @Query(value = """
            SELECT * FROM tick_data
            WHERE session_id = :sessionId
              AND tick_time >= :fromDate
              AND tick_time <= :toDate
            ORDER BY tick_time ASC
            """,
            countQuery = """
            SELECT COUNT(*) FROM tick_data
            WHERE session_id = :sessionId
              AND tick_time >= :fromDate
              AND tick_time <= :toDate
            """,
            nativeQuery = true)
    Page<TickRecord> findForCompare(
            @Param("sessionId") String sessionId,
            @Param("fromDate")  LocalDateTime fromDate,
            @Param("toDate")    LocalDateTime toDate,
            Pageable pageable);

    /**
     * Same as {@link #findForCompare} but restricted to specific instrument tokens.
     */
    @Query(value = """
            SELECT * FROM tick_data
            WHERE session_id = :sessionId
              AND instrument_token IN (:tokens)
              AND tick_time >= :fromDate
              AND tick_time <= :toDate
            ORDER BY tick_time ASC
            """,
            countQuery = """
            SELECT COUNT(*) FROM tick_data
            WHERE session_id = :sessionId
              AND instrument_token IN (:tokens)
              AND tick_time >= :fromDate
              AND tick_time <= :toDate
            """,
            nativeQuery = true)
    Page<TickRecord> findByTokensForCompare(
            @Param("sessionId") String sessionId,
            @Param("tokens")    List<Long> tokens,
            @Param("fromDate")  LocalDateTime fromDate,
            @Param("toDate")    LocalDateTime toDate,
            Pageable pageable);

    /**
     * Aggregates session metadata — one row per session_id.
     * Columns: session_id (0), first_tick (1), last_tick (2), tick_count (3), tokens (4).
     * The tokens column is a PostgreSQL array (Object[]).
     */
    @Query(value = """
            SELECT session_id,
                   MIN(tick_time)  AS first_tick,
                   MAX(tick_time)  AS last_tick,
                   COUNT(*)        AS tick_count,
                   ARRAY_AGG(DISTINCT instrument_token ORDER BY instrument_token) AS tokens
            FROM tick_data
            GROUP BY session_id
            ORDER BY MIN(tick_time) DESC
            """, nativeQuery = true)
    List<Object[]> findSessionSummaries();
}
