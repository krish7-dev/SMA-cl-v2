-- ─── Candle Data ──────────────────────────────────────────────────────────────
-- Persists normalized OHLCV bars fetched from any market data provider.
-- Used as source for replay sessions and as a cache layer for historical queries.

CREATE TABLE IF NOT EXISTS candle_data (
    id               BIGSERIAL PRIMARY KEY,
    instrument_token BIGINT          NOT NULL,
    symbol           VARCHAR(100),
    exchange         VARCHAR(20),
    interval         VARCHAR(20)     NOT NULL,
    open_time        TIMESTAMP       NOT NULL,
    open             NUMERIC(18, 4)  NOT NULL,
    high             NUMERIC(18, 4)  NOT NULL,
    low              NUMERIC(18, 4)  NOT NULL,
    close            NUMERIC(18, 4)  NOT NULL,
    volume           BIGINT          NOT NULL DEFAULT 0,
    open_interest    BIGINT          NOT NULL DEFAULT 0,
    provider         VARCHAR(50)     NOT NULL,
    fetched_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_candle_token_interval_time_provider
        UNIQUE (instrument_token, interval, open_time, provider)
);

-- Primary access pattern: load candles for a token + interval + time range
CREATE INDEX IF NOT EXISTS idx_candle_token_interval_time
    ON candle_data (instrument_token, interval, open_time);

-- Secondary: lookup by symbol when token is unknown
CREATE INDEX IF NOT EXISTS idx_candle_symbol
    ON candle_data (symbol, exchange, interval);
