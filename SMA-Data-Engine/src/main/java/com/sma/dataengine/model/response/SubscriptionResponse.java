package com.sma.dataengine.model.response;

import lombok.Builder;
import lombok.Data;

import java.util.List;

@Data
@Builder
public class SubscriptionResponse {

    /** Composite key identifying this live session: "{userId}::{brokerName}". */
    private String sessionKey;

    private String       brokerName;
    private String       mode;
    private List<Long>   subscribedTokens;
    private List<Long>   unsubscribedTokens;
    private String       status;
    private String       message;
}
