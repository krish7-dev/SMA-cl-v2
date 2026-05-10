package com.sma.aiengine.model.response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MarketContextResponse {

    private boolean      marketTradable;
    private boolean      avoidCE;
    private boolean      avoidPE;
    private double       confidence;
    private String       summary;
    private List<String> reasonCodes;
    private List<String> warningCodes;
    private String       source;   // "OPENAI" / "FALLBACK"
}
