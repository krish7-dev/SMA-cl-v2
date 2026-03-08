-- ─── Execution Engine — V1 ───────────────────────────────────────────────────
-- Stores the full lifecycle of an order intent as it flows through
-- validation, risk checks, and broker submission.

CREATE TABLE IF NOT EXISTS execution_record (
    id                  BIGSERIAL PRIMARY KEY,

    -- Caller-supplied idempotency key (one execution per intent)
    intent_id           VARCHAR(100) NOT NULL UNIQUE,

    -- ID sent to Broker Engine for its own idempotency
    broker_client_order_id VARCHAR(100),

    -- Broker's own order ID after successful submission
    broker_order_id     VARCHAR(100),

    user_id             VARCHAR(100) NOT NULL,
    broker_name         VARCHAR(50)  NOT NULL,
    symbol              VARCHAR(50)  NOT NULL,
    exchange            VARCHAR(20)  NOT NULL,

    side                VARCHAR(10)  NOT NULL,   -- BUY | SELL
    order_type          VARCHAR(20)  NOT NULL,   -- MARKET | LIMIT | SL | SL_M
    product             VARCHAR(20)  NOT NULL,   -- CNC | MIS | NRML
    quantity            INTEGER      NOT NULL,
    price               NUMERIC(18, 4),
    trigger_price       NUMERIC(18, 4),
    validity            VARCHAR(10),
    tag                 VARCHAR(100),

    -- Lifecycle status
    status              VARCHAR(30)  NOT NULL DEFAULT 'PENDING',
    error_message       TEXT,

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exec_user_broker  ON execution_record (user_id, broker_name);
CREATE INDEX IF NOT EXISTS idx_exec_status       ON execution_record (status);
CREATE INDEX IF NOT EXISTS idx_exec_broker_order ON execution_record (broker_order_id);
