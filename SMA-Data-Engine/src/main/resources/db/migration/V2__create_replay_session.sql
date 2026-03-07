-- ─── Replay Session ───────────────────────────────────────────────────────────
-- Tracks the lifecycle of each historical data replay session.
-- Sessions transition: PENDING → RUNNING → COMPLETED | STOPPED | FAILED

CREATE TABLE IF NOT EXISTS replay_session (
    id               BIGSERIAL    PRIMARY KEY,
    session_id       VARCHAR(36)  NOT NULL UNIQUE,
    instrument_token BIGINT       NOT NULL,
    symbol           VARCHAR(100),
    exchange         VARCHAR(20),
    interval         VARCHAR(20)  NOT NULL,
    from_time        TIMESTAMP    NOT NULL,
    to_time          TIMESTAMP    NOT NULL,
    speed_multiplier INT          NOT NULL DEFAULT 1,
    total_candles    INT,
    emitted_candles  INT          NOT NULL DEFAULT 0,
    status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    requested_by     VARCHAR(100),
    provider         VARCHAR(50),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replay_session_id
    ON replay_session (session_id);

CREATE INDEX IF NOT EXISTS idx_replay_status
    ON replay_session (status);

CREATE INDEX IF NOT EXISTS idx_replay_user
    ON replay_session (requested_by);
