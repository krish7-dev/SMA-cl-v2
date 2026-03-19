package com.sma.strategyengine.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sma.strategyengine.entity.LiveSnapshotRecord;
import com.sma.strategyengine.model.snapshot.LiveSessionSnapshot;
import com.sma.strategyengine.repository.LiveSnapshotRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;

@Slf4j
@Service
@RequiredArgsConstructor
public class LiveSessionStore {

    private final LiveSnapshotRepository snapshotRepository;
    private final ObjectMapper           objectMapper;

    /** Upsert snapshot to DB for (userId, brokerName). */
    @Transactional
    public void save(LiveSessionSnapshot snapshot) {
        try {
            String json = objectMapper.writeValueAsString(snapshot);
            LiveSnapshotRecord record = snapshotRepository
                    .findByUserIdAndBrokerName(snapshot.getUserId(), snapshot.getBrokerName())
                    .orElseGet(LiveSnapshotRecord::new);
            record.setUserId(snapshot.getUserId());
            record.setBrokerName(snapshot.getBrokerName());
            record.setSessionId(snapshot.getSessionId());
            record.setSavedAt(Instant.now());
            record.setStateJson(json);
            snapshotRepository.save(record);
        } catch (Exception e) {
            log.warn("Failed to save live session snapshot for {}/{}: {}",
                    snapshot.getUserId(), snapshot.getBrokerName(), e.getMessage());
        }
    }

    /** Load and deserialize snapshot for (userId, brokerName). */
    public Optional<LiveSessionSnapshot> load(String userId, String brokerName) {
        try {
            return snapshotRepository.findByUserIdAndBrokerName(userId, brokerName)
                    .map(r -> {
                        try {
                            LiveSessionSnapshot snap = objectMapper.readValue(r.getStateJson(), LiveSessionSnapshot.class);
                            // Use DB savedAt as authoritative timestamp
                            snap.setSavedAt(r.getSavedAt().toString());
                            return snap;
                        } catch (Exception e) {
                            log.warn("Failed to deserialize snapshot for {}/{}: {}", userId, brokerName, e.getMessage());
                            return null;
                        }
                    });
        } catch (Exception e) {
            log.warn("Failed to load live session snapshot for {}/{}: {}", userId, brokerName, e.getMessage());
            return Optional.empty();
        }
    }

    /** Delete snapshot for (userId, brokerName). */
    @Transactional
    public void delete(String userId, String brokerName) {
        try {
            snapshotRepository.deleteByUserIdAndBrokerName(userId, brokerName);
        } catch (Exception e) {
            log.warn("Failed to delete snapshot for {}/{}: {}", userId, brokerName, e.getMessage());
        }
    }
}
