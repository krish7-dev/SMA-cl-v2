-- ─── Add source_type to candle_data ───────────────────────────────────────────
-- Distinguishes how a candle was obtained:
--   HISTORICAL_API  — fetched from the broker REST/CSV API (standard historical pull)
--   LIVE_RECORDED   — captured in real-time from the live WebSocket tick stream
--
-- Both source types may coexist for the same (token, interval, open_time, provider),
-- allowing LIVE_RECORDED candles to be used as higher-fidelity data for replay
-- while keeping the historical baseline.

ALTER TABLE candle_data
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'HISTORICAL_API';

-- Drop the old four-column unique constraint and replace with one that includes source_type,
-- allowing HISTORICAL_API and LIVE_RECORDED to coexist for the same candle timestamp.
ALTER TABLE candle_data
    DROP CONSTRAINT IF EXISTS uq_candle_token_interval_time_provider;

ALTER TABLE candle_data
    ADD CONSTRAINT uq_candle_token_interval_time_provider_source
        UNIQUE (instrument_token, interval, open_time, provider, source_type);

-- Index to efficiently query live-recorded candles separately from historical ones
CREATE INDEX IF NOT EXISTS idx_candle_source_type
    ON candle_data (source_type, instrument_token, interval, open_time);
