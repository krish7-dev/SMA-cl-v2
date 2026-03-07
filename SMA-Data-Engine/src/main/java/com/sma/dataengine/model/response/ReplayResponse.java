package com.sma.dataengine.model.response;

import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@Builder
public class ReplayResponse {

    private String        sessionId;
    private Long          instrumentToken;
    private String        symbol;
    private String        exchange;
    private String        interval;
    private LocalDateTime fromDate;
    private LocalDateTime toDate;
    private int           speedMultiplier;
    private int           totalCandles;
    private String        status;
    private String        message;
}
