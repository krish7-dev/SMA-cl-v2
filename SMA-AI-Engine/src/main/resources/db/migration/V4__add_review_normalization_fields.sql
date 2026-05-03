-- Add normalization audit fields to trade_review_record
ALTER TABLE trade_review_record
    ADD COLUMN IF NOT EXISTS normalized            BOOLEAN  DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS normalization_reasons JSONB,
    ADD COLUMN IF NOT EXISTS raw_response_json     TEXT;
