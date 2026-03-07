package com.sma.dataengine.repository;

import com.sma.dataengine.entity.CandleRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface CandleRepository extends JpaRepository<CandleRecord, Long> {

    /**
     * Core query — loads candles for replay or cache lookup.
     * Results are ordered oldest-first for sequential processing.
     */
    List<CandleRecord> findByInstrumentTokenAndIntervalAndProviderAndOpenTimeBetweenOrderByOpenTimeAsc(
            Long instrumentToken,
            String interval,
            String provider,
            LocalDateTime from,
            LocalDateTime to
    );

    /**
     * Checks whether candles exist for the given range — used for cache hit detection.
     */
    @Query("""
            SELECT COUNT(c) > 0 FROM CandleRecord c
            WHERE c.instrumentToken = :token
              AND c.interval        = :interval
              AND c.provider        = :provider
              AND c.openTime       >= :from
              AND c.openTime       <= :to
            """)
    boolean existsInRange(
            @Param("token")    Long instrumentToken,
            @Param("interval") String interval,
            @Param("provider") String provider,
            @Param("from")     LocalDateTime from,
            @Param("to")       LocalDateTime to
    );

    /** Convenience — load by symbol + exchange when token is unknown. */
    List<CandleRecord> findBySymbolAndExchangeAndIntervalAndOpenTimeBetweenOrderByOpenTimeAsc(
            String symbol,
            String exchange,
            String interval,
            LocalDateTime from,
            LocalDateTime to
    );

    /**
     * Returns the open_time values already stored for a token/interval/provider range.
     * Used to pre-filter inserts and avoid unique-constraint violations without relying
     * on catching DB exceptions (which poison the active transaction in PostgreSQL).
     */
    @Query("""
            SELECT c.openTime FROM CandleRecord c
            WHERE c.instrumentToken = :token
              AND c.interval        = :interval
              AND c.provider        = :provider
              AND c.openTime       >= :from
              AND c.openTime       <= :to
            """)
    List<LocalDateTime> findOpenTimesInRange(
            @Param("token")    Long instrumentToken,
            @Param("interval") String interval,
            @Param("provider") String provider,
            @Param("from")     LocalDateTime from,
            @Param("to")       LocalDateTime to
    );
}
