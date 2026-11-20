-- R7. Atomic idempotency receipts for explicit retries after lost responses.
-- Receipts retain no contact fields, notes, raw request keys or secret tokens.
-- Keep a receipt after record deletion so old drafts cannot resurrect data.
CREATE TABLE IF NOT EXISTS command_requests (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('contact','expense')),
  key_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation,key_hash)
);
CREATE INDEX IF NOT EXISTS command_contacts_outcome_day ON command_contacts(outcome,day,created_at);
