-- R3. Apply to staging D1 AFTER 0001_init.sql, before deploying the R3 Worker.
CREATE TABLE IF NOT EXISTS editorial_draft (
  slot INTEGER PRIMARY KEY CHECK (slot=1),
  revision INTEGER NOT NULL DEFAULT 0,
  document_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS editorial_live (
  slot INTEGER PRIMARY KEY CHECK (slot=1),
  version INTEGER NOT NULL,
  public_json TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS editorial_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  revision INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS editorial_audit_at_idx ON editorial_audit(at);
CREATE TABLE IF NOT EXISTS lead_reviews (
  lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('new','triaged','replied','closed')) DEFAULT 'new',
  internal_note TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operator_audit (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject_id TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS digest_campaigns (
  id TEXT PRIMARY KEY,
  episode_day INTEGER NOT NULL CHECK(episode_day BETWEEN 1 AND 10),
  subject TEXT NOT NULL,
  intro TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','queued','sending','completed','cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS digest_deliveries (
  campaign_id TEXT NOT NULL REFERENCES digest_campaigns(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  sent_at TEXT,
  message_id TEXT,
  PRIMARY KEY(campaign_id,email_hash)
);
CREATE INDEX IF NOT EXISTS digest_delivery_status_idx ON digest_deliveries(campaign_id,status);
-- Future D1 migrations should keep private approval evidence and recipient emails out of public JSON.
