-- V5: add raw tick capture column to session_result
-- Stores a JSON array of tick events ({token, ltp, timeMs}) captured during the session.
-- Used for tick-level live-vs-replay divergence analysis.
ALTER TABLE session_result ADD COLUMN IF NOT EXISTS ticks_json TEXT;
