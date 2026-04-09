CREATE TABLE IF NOT EXISTS session_result (
    session_id         VARCHAR(100) PRIMARY KEY,
    type               VARCHAR(20)  NOT NULL,
    user_id            VARCHAR(100),
    broker_name        VARCHAR(50),
    session_date       DATE,
    label              VARCHAR(200),
    config_json        TEXT,
    closed_trades_json TEXT,
    feed_json          TEXT,
    summary_json       TEXT,
    saved_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_result_user ON session_result (user_id, session_date DESC);
