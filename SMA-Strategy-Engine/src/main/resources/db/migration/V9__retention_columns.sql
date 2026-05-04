-- V9: Add retention and archive metadata to session_result.
--
-- retain_until: timestamp after which this row is eligible for archival or cleanup.
--   NULL = keep forever (all existing rows default to this — no data is affected).
-- archive_url: external storage reference once feed chunks are offloaded to object storage.
--   NULL = feed still lives in session_feed_chunk (normal operating state).
--
-- No data deleted. No index changes. Purely additive.
-- Retention cleanup is opt-in via SMA_RETENTION_ENABLED=true env flag (future Phase 2).

ALTER TABLE session_result
    ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ;

ALTER TABLE session_result
    ADD COLUMN IF NOT EXISTS archive_url  TEXT;
