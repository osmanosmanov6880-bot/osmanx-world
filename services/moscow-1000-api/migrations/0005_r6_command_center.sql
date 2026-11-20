-- R6. Private operator data and real Google OAuth. No demo records are inserted.
CREATE TABLE IF NOT EXISTS google_auth_flows (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS google_auth_flows_expiry ON google_auth_flows(expires_at);
CREATE TABLE IF NOT EXISTS google_admin_sessions (
  id_hash TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS google_admin_sessions_expiry ON google_admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS command_contacts (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 10),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  person TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK(outcome IN ('visited','dialogue','interest','refusal','meeting','pilot','contract')),
  problem TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS command_contacts_day ON command_contacts(day,created_at);
CREATE TABLE IF NOT EXISTS command_expenses (
  id TEXT PRIMARY KEY,
  day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 10),
  amount_kopecks INTEGER NOT NULL CHECK(amount_kopecks BETWEEN 1 AND 100000000),
  category TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS command_expenses_day ON command_expenses(day,created_at);
CREATE TABLE IF NOT EXISTS command_quests (
  day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 10),
  quest_id TEXT NOT NULL,
  completed INTEGER NOT NULL CHECK(completed IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY(day,quest_id)
);
CREATE TABLE IF NOT EXISTS command_state (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);
INSERT OR IGNORE INTO command_state(slot,revision) VALUES(1,0);
CREATE TABLE IF NOT EXISTS command_public (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
