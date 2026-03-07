-- ============================================================
-- V2: Create order_record table
-- ============================================================
-- Persists the full lifecycle of every order submitted through
-- the Broker Engine. client_order_id is the platform-generated
-- idempotency key — the same value must never produce two orders.
-- ============================================================

CREATE TABLE order_record (
    id                    BIGSERIAL PRIMARY KEY,
    client_order_id       VARCHAR(100)   NOT NULL,
    broker_order_id       VARCHAR(100),
    broker_account_id     BIGINT         NOT NULL REFERENCES broker_account(id),
    symbol                VARCHAR(50)    NOT NULL,
    exchange              VARCHAR(20)    NOT NULL,
    transaction_type      VARCHAR(10)    NOT NULL,
    order_type            VARCHAR(20)    NOT NULL,
    product               VARCHAR(20)    NOT NULL,
    quantity              INTEGER        NOT NULL,
    price                 NUMERIC(18,4),
    trigger_price         NUMERIC(18,4),
    status                VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
    status_message        TEXT,
    filled_quantity       INTEGER,
    average_price         NUMERIC(18,4),
    validity              VARCHAR(10),
    tag                   VARCHAR(100),
    raw_broker_response   TEXT,
    placed_at             TIMESTAMPTZ,
    updated_by_broker_at  TIMESTAMPTZ,
    created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_order_record_client_order_id UNIQUE (client_order_id),
    CONSTRAINT chk_order_record_transaction_type CHECK (transaction_type IN ('BUY','SELL')),
    CONSTRAINT chk_order_record_order_type       CHECK (order_type IN ('MARKET','LIMIT','SL','SL_M')),
    CONSTRAINT chk_order_record_product          CHECK (product IN ('CNC','MIS','NRML')),
    CONSTRAINT chk_order_record_status           CHECK (status IN (
        'PENDING','OPEN','COMPLETE','CANCELLED','REJECTED','TRIGGER_PENDING','AMO_REQ_RECEIVED'
    )),
    CONSTRAINT chk_order_record_quantity         CHECK (quantity > 0)
);

CREATE INDEX idx_order_record_client_order_id   ON order_record (client_order_id);
CREATE INDEX idx_order_record_broker_account_id ON order_record (broker_account_id);
CREATE INDEX idx_order_record_broker_order_id   ON order_record (broker_order_id);
CREATE INDEX idx_order_record_status            ON order_record (status);
CREATE INDEX idx_order_record_placed_at         ON order_record (placed_at DESC);

COMMENT ON TABLE  order_record                  IS 'Full order lifecycle for all broker-submitted orders';
COMMENT ON COLUMN order_record.client_order_id  IS 'Platform idempotency key — unique per order intent';
COMMENT ON COLUMN order_record.broker_order_id  IS 'Order ID assigned by the broker on successful placement';
COMMENT ON COLUMN order_record.raw_broker_response IS 'Raw JSON response from broker for debugging';
