-- ─── Idempotent Tick Ingestion ────────────────────────────────────────────────
-- Adds a unique constraint on (instrument_token, session_id, tick_time) so that
-- the Redis-Stream drainer can use INSERT ... ON CONFLICT DO NOTHING.
-- This eliminates duplicate rows when a drainer batch is replayed after a crash
-- before XACK was written (DB-write-before-XACK gap).

-- Remove duplicate rows, keeping the one with the lowest id
DELETE FROM tick_data a
USING tick_data b
WHERE a.id > b.id
  AND a.instrument_token = b.instrument_token
  AND a.session_id        = b.session_id
  AND a.tick_time         = b.tick_time;

ALTER TABLE tick_data
    ADD CONSTRAINT uq_tick_data_token_session_time
        UNIQUE (instrument_token, session_id, tick_time);
