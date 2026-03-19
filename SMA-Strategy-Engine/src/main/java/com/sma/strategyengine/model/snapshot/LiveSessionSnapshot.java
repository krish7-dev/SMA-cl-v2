package com.sma.strategyengine.model.snapshot;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

@Data @Builder @NoArgsConstructor @AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class LiveSessionSnapshot {

    String sessionId;
    String userId;
    String brokerName;
    String savedAt;       // ISO-8601
    String configJson;    // full LiveEvalRequest serialized for reference (optional)

    /** token → instrument snapshot */
    Map<String, InstrumentSnapshot> instruments;

    /** token → list of candle log entries (for UI restoration) */
    Map<String, List<CandleLogEntry>> candleLogs;

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class InstrumentSnapshot {
        /** stratLabel → strategy state */
        Map<String, StrategyState> strategies;
        /** Combined pool state */
        StrategyState combined;
    }

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class StrategyState {
        double capital;
        OpenPos openPosition;   // null if flat
        List<ClosedTradeEntry> closedTrades;
        List<EquityEntry>      equityPoints;
        int cooldown;
        int revCooldown;
    }

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class OpenPos {
        String type;           // LONG or SHORT
        double entryPrice;
        int    qty;
        String entryTime;
        String regime;
        String sourceStrategy;
        Double slPrice;
        Double tpPrice;
    }

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ClosedTradeEntry {
        String entryTime;
        String exitTime;
        String direction;
        double entryPrice;
        double exitPrice;
        int    qty;
        double pnl;
        String exitReason;
        String regime;
        String strategyLabel;
    }

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class EquityEntry {
        String time;
        double capital;
    }

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class CandleLogEntry {
        String candleTime;
        double open, high, low, close;
        long   volume;
        String regime;
        // Keep these as raw Object to avoid type issues
        Map<String, Object> signals;
        List<Object>        actions;
        List<Object>        blockedSignals;
        List<Object>        combinedDetails;
    }
}
