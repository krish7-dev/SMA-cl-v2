ALTER TABLE advisory_record
    ADD COLUMN IF NOT EXISTS ai_model       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS ai_api_mode    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS ai_prompt_mode VARCHAR(20);

ALTER TABLE trade_review_record
    ADD COLUMN IF NOT EXISTS ai_model       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS ai_api_mode    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS ai_prompt_mode VARCHAR(20);
