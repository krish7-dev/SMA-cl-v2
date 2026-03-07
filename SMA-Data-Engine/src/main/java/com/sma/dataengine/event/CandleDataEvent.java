package com.sma.dataengine.event;

import com.sma.dataengine.model.CandleData;
import org.springframework.context.ApplicationEvent;

/**
 * Spring application event published for each candle emitted during replay
 * or when a completed candle is formed from live ticks.
 *
 * Listeners receive this event to drive strategy evaluation, UI updates,
 * or indicator computation without coupling to the data layer.
 */
public class CandleDataEvent extends ApplicationEvent {

    private final CandleData candle;

    /** True when emitted by ReplayService, false for live/real-time candles. */
    private final boolean     replay;
    private final String      replaySessionId;

    public CandleDataEvent(Object source, CandleData candle, boolean replay, String replaySessionId) {
        super(source);
        this.candle          = candle;
        this.replay          = replay;
        this.replaySessionId = replaySessionId;
    }

    public CandleData getCandle()          { return candle; }
    public boolean    isReplay()           { return replay; }
    public String     getReplaySessionId() { return replaySessionId; }
}
