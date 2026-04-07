package com.sma.dataengine.service;

import com.sma.dataengine.model.request.LiveTickIngestRequest;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Slf4j
@Service
public class LiveTickIngestService {

    @PersistenceContext
    private EntityManager em;

    @Transactional
    public int ingest(LiveTickIngestRequest request) {
        List<LiveTickIngestRequest.TickEntry> entries = request.getTicks();
        if (entries == null || entries.isEmpty()) return 0;

        String sessionId = request.getSessionId();
        String provider  = request.getProvider();

        int count = 0;
        for (LiveTickIngestRequest.TickEntry e : entries) {
            if (e.getInstrumentToken() == null || e.getTickTime() == null) continue;
            em.createNativeQuery(
                "INSERT INTO tick_data (instrument_token, symbol, exchange, ltp, volume, tick_time, session_id, provider) " +
                "VALUES (?, ?, ?, ?, ?, CAST(? AS timestamp), ?, ?)")
              .setParameter(1, e.getInstrumentToken())
              .setParameter(2, e.getSymbol())
              .setParameter(3, e.getExchange())
              .setParameter(4, e.getLtp())
              .setParameter(5, e.getVolume())
              .setParameter(6, e.getTickTime())
              .setParameter(7, sessionId)
              .setParameter(8, provider)
              .executeUpdate();
            count++;
        }

        log.info("LiveTickIngest: sessionId={} persisted={}", sessionId, count);
        return count;
    }
}
