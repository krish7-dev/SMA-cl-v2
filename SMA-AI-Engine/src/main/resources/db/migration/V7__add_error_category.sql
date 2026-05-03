ALTER TABLE advisory_record
    ADD COLUMN IF NOT EXISTS error_category VARCHAR(20);

ALTER TABLE trade_review_record
    ADD COLUMN IF NOT EXISTS error_category VARCHAR(20);
