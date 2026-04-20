-- ─── Idempotent Feed Chunk Persistence ──────────────────────────────────────
-- Adds stream_last_id to session_feed_chunk to enable ON CONFLICT DO NOTHING
-- when the Redis-Stream drainer re-drains a batch after a crash before XACK.
--
-- Format: "firstMessageId:lastMessageId" (e.g. "1713330500000-0:1713330503000-5").
-- One DB row maps to exactly one drained batch, making the pair deterministic.
-- Existing rows have stream_last_id = NULL; NULL != NULL, so the unique
-- constraint does not affect legacy rows.

ALTER TABLE session_feed_chunk
    ADD COLUMN IF NOT EXISTS stream_last_id VARCHAR(80);

ALTER TABLE session_feed_chunk
    ADD CONSTRAINT uq_feed_chunk_stream
        UNIQUE (session_id, stream_last_id);
