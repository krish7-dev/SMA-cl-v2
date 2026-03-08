package com.sma.strategyengine.service;

import com.sma.strategyengine.entity.SignalRecord;
import com.sma.strategyengine.model.response.SignalResponse;
import com.sma.strategyengine.repository.SignalRecordRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class SignalService {

    private final SignalRecordRepository repository;

    @Transactional(readOnly = true)
    public List<SignalResponse> getByInstance(String instanceId) {
        return repository.findByInstanceIdOrderByCreatedAtDesc(instanceId)
                .stream().map(SignalResponse::from).toList();
    }

    @Transactional(readOnly = true)
    public List<SignalResponse> getBySymbol(String symbol, String exchange) {
        return repository.findBySymbolAndExchangeOrderByCreatedAtDesc(
                        symbol.toUpperCase(), exchange.toUpperCase())
                .stream().map(SignalResponse::from).toList();
    }

    @Transactional(readOnly = true)
    public List<SignalResponse> getActionableByInstance(String instanceId) {
        List<SignalRecord> buys  = repository.findByInstanceIdAndSignalOrderByCreatedAtDesc(instanceId, SignalRecord.Signal.BUY);
        List<SignalRecord> sells = repository.findByInstanceIdAndSignalOrderByCreatedAtDesc(instanceId, SignalRecord.Signal.SELL);
        return java.util.stream.Stream.concat(buys.stream(), sells.stream())
                .sorted(java.util.Comparator.comparing(SignalRecord::getCreatedAt).reversed())
                .map(SignalResponse::from)
                .toList();
    }
}
