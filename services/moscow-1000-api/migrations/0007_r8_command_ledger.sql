-- R8: optimistic expense editing and efficient private audit/ledger reads.
-- Additive schema only. Existing records keep their original creation timestamp;
-- the API reports created_at until the first recorded edit supplies updated_at.
ALTER TABLE command_expenses ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE command_expenses ADD COLUMN updated_at TEXT;
ALTER TABLE command_expenses ADD COLUMN updated_by TEXT;
CREATE INDEX IF NOT EXISTS command_expenses_category_day ON command_expenses(category,day,created_at,id);
CREATE INDEX IF NOT EXISTS operator_audit_event_time ON operator_audit(event,at,id);
