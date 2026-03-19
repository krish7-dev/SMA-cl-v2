CREATE TABLE IF NOT EXISTS live_session_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    user_id         VARCHAR(100) NOT NULL,
    broker_name     VARCHAR(50)  NOT NULL,
    session_id      VARCHAR(100),
    saved_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    state_json      TEXT         NOT NULL,
    CONSTRAINT uq_live_snapshot UNIQUE (user_id, broker_name)
);
