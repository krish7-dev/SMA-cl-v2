-- Add validation/normalization audit fields to advisory_record
ALTER TABLE advisory_record
    ADD COLUMN IF NOT EXISTS normalized            BOOLEAN  DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS normalization_reasons JSONB,
    ADD COLUMN IF NOT EXISTS raw_response_json     TEXT;
