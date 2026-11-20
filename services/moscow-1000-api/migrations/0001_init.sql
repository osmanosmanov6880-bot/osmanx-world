-- D1 SQLite; private data is never copied to the static website.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('business','partner','research')),
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at);
CREATE TABLE IF NOT EXISTS subscriptions (
  email_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  confirm_hash TEXT NOT NULL,
  unsub_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','subscribed','unsubscribed')),
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS subscribers_status_idx ON subscriptions (status);
