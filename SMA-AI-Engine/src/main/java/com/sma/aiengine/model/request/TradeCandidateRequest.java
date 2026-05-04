package com.sma.aiengine.model.request;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;

@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class TradeCandidateRequest {

    @NotBlank
    private String sessionId;

    @NotBlank
    private String symbol;

    @NotBlank
    private String side;

    private Instant candleTime;

    private BigDecimal entryPrice;
    private Integer quantity;

    private String regime;
    private String winningStrategy;
    private Double winningScore;
    private Double oppositeScore;
    private Double scoreGap;

    private Double recentMove3CandlePct;
    private Double recentMove5CandlePct;
    private Double vwapDistancePct;
    private Double candleBodyPct;
    private Double adx;
    private Double atrPct;

    private BigDecimal optionPremium;

    private Integer barsSinceLastTrade;
    private Integer tradesToday;
    private BigDecimal dailyPnl;            // legacy alias — prefer dailyPnlBeforeTrade
    private Double dailyPnlBeforeTrade;     // realized P&L before this trade
    private BigDecimal capitalBefore;

    private Boolean compressionNoTradeEnabled;
    private Boolean minMovementFilterPassed;
    private Boolean directionalConsistencyPassed;
    private Boolean candleStrengthFilterPassed;

    // Current option type (CE/PE — both are bought long, not BUY/SELL)
    private String  currentOptionType;

    // Previous trade context — helps detect reversal traps (e.g. PE after strong CE win)
    private String  previousTradeSymbol;
    private String  previousTradeOptionType;          // CE or PE
    private Double  previousTradePnlPct;
    private String  previousTradeExitReason;
    private String  previousTradeExitTime;
    private Integer minutesSincePreviousExit;
    private Boolean previousTradeWasStrongWinner;     // pnlPct >= 8.0
    private Boolean isOppositeSideAfterStrongWinner;  // prevOptionType != currentOptionType && prevWasStrongWin

    // Last ≤5 completed NIFTY candles — compact shape only, no raw ticks
    private List<Map<String, Object>> recentCandles;

    // Precomputed candle alignment — prevents AI from re-deriving direction and getting it wrong
    private String  instrumentContext;              // UNDERLYING (recentCandles = NIFTY candles, not option premium)
    private Integer recentCandlesSupportTradeCount; // DOWN count for PE, UP count for CE
    private Integer recentCandlesOpposeTradeCount;  // UP count for PE, DOWN count for CE
    private Boolean lastCandleSupportsTrade;         // true if most recent candle favors this trade
    private String  recentMomentumAlignment;         // SUPPORTS_TRADE | OPPOSES_TRADE | MIXED
}
