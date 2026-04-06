package com.sma.dataengine.service;

import com.sma.dataengine.model.TickRecord;
import com.sma.dataengine.model.request.LiveTickIngestRequest;
import com.sma.dataengine.repository.TickRecordRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class LiveTickIngestService {

    private final TickRecordRepository tickRecordRepository;

    public int ingest(LiveTickIngestRequest request) {
        List<LiveTickIngestRequest.TickEntry> entries = request.getTicks();
        if (entries == null || entries.isEmpty()) return 0;

        List<TickRecord> records = entries.stream()
                .filter(e -> e.getInstrumentToken() != null && e.getTickTime() != null)
                .map(e -> TickRecord.builder()
                        .instrumentToken(e.getInstrumentToken())
                        .symbol(e.getSymbol())
                        .exchange(e.getExchange())
                        .ltp(BigDecimal.valueOf(e.getLtp()))
                        .volume(e.getVolume())
                        .tickTime(LocalDateTime.parse(e.getTickTime()))
                        .sessionId(request.getSessionId())
                        .provider(request.getProvider())
                        .build())
                .toList();

        tickRecordRepository.saveAll(records);
        log.debug("LiveTickIngest: sessionId={} persisted={}", request.getSessionId(), records.size());
        return records.size();
    }
}
