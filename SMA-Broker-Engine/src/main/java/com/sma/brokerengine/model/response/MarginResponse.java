package com.sma.brokerengine.model.response;

import lombok.Builder;
import lombok.Data;

import java.math.BigDecimal;

@Data
@Builder
public class MarginResponse {

    private String segment;
    private BigDecimal available;
    private BigDecimal utilised;
    private BigDecimal net;
    private BigDecimal openingBalance;
    private BigDecimal payin;
    private BigDecimal payout;
    private BigDecimal liveBalance;
}
