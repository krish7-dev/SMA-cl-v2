-- AI Engine V2 — trade_review_record
-- Stores AI quality review for completed trades.
-- Uniqueness enforced on (session_id, trade_id) — same trade may be reviewed across sessions.

CREATE TABLE IF NOT EXISTS trade_review_record (
    id              BIGSERIAL PRIMARY KEY,

    trade_id        VARCHAR(100)  NOT NULL,
    session_id      VARCHAR(100),
    symbol          VARCHAR(50),
    side            VARCHAR(10),
    regime          VARCHAR(50),

    entry_time      TIMESTAMPTZ,
    exit_time       TIMESTAMPTZ,
    pnl             NUMERIC(18, 4),
    pnl_pct         DOUBLE PRECISION,
    exit_reason     VARCHAR(100),

    quality         VARCHAR(20)   NOT NULL DEFAULT 'UNKNOWN',
    avoidable       BOOLEAN,
    mistake_type    VARCHAR(50),
    confidence      DOUBLE PRECISION,
    summary         TEXT,

    what_worked     JSONB,
    what_failed     JSONB,
    suggested_rule  TEXT,
    reason_codes    JSONB,
    warning_codes   JSONB,

    source          VARCHAR(20)   NOT NULL,
    latency_ms      BIGINT,

    request_json    TEXT,
    response_json   TEXT,
    error_details   TEXT,
    request_id      VARCHAR(100),

    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_rev_session_trade UNIQUE (session_id, trade_id)
);

CREATE INDEX IF NOT EXISTS idx_rev_session       ON trade_review_record (session_id);
CREATE INDEX IF NOT EXISTS idx_rev_symbol        ON trade_review_record (symbol);
CREATE INDEX IF NOT EXISTS idx_rev_session_trade ON trade_review_record (session_id, trade_id);
