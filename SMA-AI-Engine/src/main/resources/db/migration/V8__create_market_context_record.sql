-- AI Engine V8 — market_context_record
-- Stores AI market-context evaluations fired on each NIFTY candle close during a live session.
-- Upsert key: (session_id, candle_time) — re-running the same candle replaces the previous evaluation.

CREATE TABLE IF NOT EXISTS market_context_record (
    id               BIGSERIAL PRIMARY KEY,

    session_id       VARCHAR(100)     NOT NULL,
    candle_time      TIMESTAMPTZ      NOT NULL,
    regime           VARCHAR(50),

    market_tradable  BOOLEAN,
    avoid_ce         BOOLEAN,
    avoid_pe         BOOLEAN,
    confidence       DOUBLE PRECISION,

    summary          TEXT,
    reason_codes     JSONB,
    warning_codes    JSONB,

    source           VARCHAR(20)      NOT NULL,
    latency_ms       BIGINT,

    request_json     TEXT,
    response_json    TEXT,
    request_id       VARCHAR(100),
    ai_model         VARCHAR(100),
    ai_prompt_mode   VARCHAR(20),

    created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_market_ctx_session_candle UNIQUE (session_id, candle_time)
);

CREATE INDEX IF NOT EXISTS idx_mctx_session    ON market_context_record (session_id);
CREATE INDEX IF NOT EXISTS idx_mctx_candle     ON market_context_record (candle_time);
CREATE INDEX IF NOT EXISTS idx_mctx_request_id ON market_context_record (request_id);
