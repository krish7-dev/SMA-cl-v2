package com.sma.aiengine.model.request;

import lombok.Data;

import java.time.Instant;
import java.util.List;
import java.util.Map;

@Data
public class MarketContextRequest {

    private String  sessionId;
    private Instant candleTime;
    private String  timeOfDay;      // "HH:MM" IST — prompt context only
    private String  regime;

    // Direction context
    private String  niftyDirection;  // UP / DOWN / DOJI — last closed candle
    private String  shortTermTrend;  // UPTREND / DOWNTREND / SIDEWAYS (3-candle net)

    // Candle counts (last ≤5)
    private int     upCandlesCount;
    private int     downCandlesCount;

    // Movement metrics (UNSIGNED %)
    private Double  recentMove3CandlePct;
    private Double  recentMove5CandlePct;

    // Technical
    private Double  vwapDistancePct;  // signed (+ve = above VWAP)
    private Double  adx;
    private Double  atrPct;
    private Double  candleBodyPct;    // |close-open| / open * 100

    // Decision engine state
    private Double  winningScore;
    private Double  scoreGap;

    // Session context
    private int     tradesToday;
    private Double  dailyPnl;
    private Double  sessionCapital;

    // Raw candles (compact format, last ≤5)
    private List<Map<String, Object>> recentCandles;
}
