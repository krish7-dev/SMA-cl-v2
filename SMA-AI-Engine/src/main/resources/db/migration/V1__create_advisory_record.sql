-- AI Engine V1 — advisory_record
-- Stores AI advisory output for trade candidates.
-- reason_codes / warning_codes stored as jsonb for future array-contains queries.
-- request_json / response_json stored as text (raw JSON blobs for audit).

CREATE TABLE IF NOT EXISTS advisory_record (
    id                  BIGSERIAL PRIMARY KEY,

    session_id          VARCHAR(100)  NOT NULL,
    symbol              VARCHAR(50)   NOT NULL,
    side                VARCHAR(10),
    regime              VARCHAR(50),
    candle_time         TIMESTAMPTZ,

    action              VARCHAR(20)   NOT NULL DEFAULT 'UNKNOWN',
    confidence          DOUBLE PRECISION,
    trade_quality_score DOUBLE PRECISION,
    risk_level          VARCHAR(20),
    reversal_risk       DOUBLE PRECISION,
    chop_risk           DOUBLE PRECISION,
    late_entry_risk     DOUBLE PRECISION,
    overextension_risk  DOUBLE PRECISION,

    reason_codes        JSONB,
    warning_codes       JSONB,
    summary             TEXT,

    source              VARCHAR(20)   NOT NULL,
    latency_ms          BIGINT,

    request_json        TEXT,
    response_json       TEXT,
    error_details       TEXT,
    request_id          VARCHAR(100),

    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adv_session    ON advisory_record (session_id);
CREATE INDEX IF NOT EXISTS idx_adv_symbol     ON advisory_record (symbol);
CREATE INDEX IF NOT EXISTS idx_adv_action     ON advisory_record (action);
CREATE INDEX IF NOT EXISTS idx_adv_request_id ON advisory_record (request_id);
