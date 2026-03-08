-- Strategy Engine schema

CREATE TABLE IF NOT EXISTS strategy_instance (
    id              BIGSERIAL    PRIMARY KEY,
    instance_id     VARCHAR(100) NOT NULL UNIQUE,
    name            VARCHAR(200) NOT NULL,
    strategy_type   VARCHAR(50)  NOT NULL,
    user_id         VARCHAR(100) NOT NULL,
    broker_name     VARCHAR(50)  NOT NULL,
    symbol          VARCHAR(50)  NOT NULL,
    exchange        VARCHAR(20)  NOT NULL,
    product         VARCHAR(20)  NOT NULL DEFAULT 'MIS',
    quantity        INTEGER      NOT NULL,
    order_type      VARCHAR(20)  NOT NULL DEFAULT 'MARKET',
    parameters      TEXT,
    status          VARCHAR(20)  NOT NULL DEFAULT 'INACTIVE',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_si_user_status  ON strategy_instance (user_id, status);
CREATE INDEX IF NOT EXISTS idx_si_symbol_status ON strategy_instance (symbol, exchange, status);

-- Signal audit log: one row per signal generated (BUY / SELL / HOLD)
CREATE TABLE IF NOT EXISTS signal_record (
    id               BIGSERIAL    PRIMARY KEY,
    signal_id        VARCHAR(100) NOT NULL UNIQUE,
    instance_id      VARCHAR(100) NOT NULL,
    strategy_type    VARCHAR(50)  NOT NULL,
    symbol           VARCHAR(50)  NOT NULL,
    exchange         VARCHAR(20)  NOT NULL,
    signal           VARCHAR(10)  NOT NULL,
    candle_close     NUMERIC(18, 4),
    intent_id        VARCHAR(100),
    execution_status VARCHAR(20)  NOT NULL DEFAULT 'SKIPPED',
    meta             TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sr_instance   ON signal_record (instance_id);
CREATE INDEX IF NOT EXISTS idx_sr_symbol     ON signal_record (symbol, exchange);
CREATE INDEX IF NOT EXISTS idx_sr_created    ON signal_record (created_at DESC);
