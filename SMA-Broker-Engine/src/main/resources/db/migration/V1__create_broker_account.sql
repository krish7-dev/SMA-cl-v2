-- ============================================================
-- V1: Create broker_account table
-- ============================================================
-- Stores one record per (user, broker) pair.
-- Sensitive fields (api_key, api_secret, access_token) are
-- encrypted at the application layer using AES/GCM before storage.
-- ============================================================

CREATE TABLE broker_account (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              VARCHAR(100)  NOT NULL,
    broker_name          VARCHAR(50)   NOT NULL,
    client_id            VARCHAR(100)  NOT NULL,
    api_key_encrypted    TEXT          NOT NULL,
    api_secret_encrypted TEXT          NOT NULL,
    access_token_encrypted TEXT,
    token_expiry         TIMESTAMPTZ,
    status               VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_broker_account_user_broker UNIQUE (user_id, broker_name),
    CONSTRAINT chk_broker_account_status CHECK (status IN ('ACTIVE','INACTIVE','TOKEN_EXPIRED','SUSPENDED'))
);

CREATE INDEX idx_broker_account_user_id ON broker_account (user_id);
CREATE INDEX idx_broker_account_status   ON broker_account (status);

COMMENT ON TABLE  broker_account                   IS 'Registered broker accounts with encrypted credentials';
COMMENT ON COLUMN broker_account.user_id           IS 'Platform user identifier';
COMMENT ON COLUMN broker_account.broker_name       IS 'Canonical broker name, e.g. kite, angelone';
COMMENT ON COLUMN broker_account.api_key_encrypted IS 'AES/GCM encrypted broker API key';
COMMENT ON COLUMN broker_account.access_token_encrypted IS 'AES/GCM encrypted session access token';
