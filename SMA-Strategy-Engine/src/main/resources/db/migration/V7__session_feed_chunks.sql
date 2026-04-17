-- V7: replace JSONB-append pattern with append-only chunk table.
-- feed_json on session_result is kept for backward compat (old rows + manual saves).
-- New auto-save writes go to session_feed_chunk; read path assembles from chunks first.

CREATE TABLE IF NOT EXISTS session_feed_chunk (
    id          BIGSERIAL    PRIMARY KEY,
    session_id  VARCHAR(100) NOT NULL,
    chunk_json  TEXT         NOT NULL,
    saved_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_feed_chunk_session ON session_feed_chunk (session_id, id);
