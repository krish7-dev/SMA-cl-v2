-- Add shorting support to strategy_instance
ALTER TABLE strategy_instance
    ADD COLUMN IF NOT EXISTS allow_shorting BOOLEAN NOT NULL DEFAULT FALSE;
