-- ─── Raw Tick Data ────────────────────────────────────────────────────────────
-- Stores every raw LTP tick received from the broker WebSocket during a live
-- options session. Used to reconstruct intra-candle price action for replay.

CREATE TABLE IF NOT EXISTS tick_data (
    id               BIGSERIAL PRIMARY KEY,
    instrument_token BIGINT          NOT NULL,
    symbol           VARCHAR(100),
    exchange         VARCHAR(20),
    ltp              NUMERIC(18, 4)  NOT NULL,
    volume           BIGINT          NOT NULL DEFAULT 0,
    tick_time        TIMESTAMP       NOT NULL,
    session_id       VARCHAR(100)    NOT NULL,
    provider         VARCHAR(50)     NOT NULL DEFAULT 'kite',
    recorded_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Primary access pattern: load ticks for a token + session + time range
CREATE INDEX IF NOT EXISTS idx_tick_token_session_time
    ON tick_data (instrument_token, session_id, tick_time);

-- Lookup all ticks for a session
CREATE INDEX IF NOT EXISTS idx_tick_session
    ON tick_data (session_id, tick_time);
