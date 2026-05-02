-- Widen side column from VARCHAR(10) to VARCHAR(20) in both tables.
-- "LONG_OPTION" (11 chars) exceeded the original limit.
ALTER TABLE advisory_record      ALTER COLUMN side TYPE VARCHAR(20);
ALTER TABLE trade_review_record  ALTER COLUMN side TYPE VARCHAR(20);
