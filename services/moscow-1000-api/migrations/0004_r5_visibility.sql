-- R5: durable D1 -> Stream visibility reconciliation. Does not contain customer data.
CREATE TABLE IF NOT EXISTS stream_visibility (
 uid TEXT PRIMARY KEY CHECK(length(uid)=32),
 desired TEXT NOT NULL CHECK(desired IN ('public','private')),
 state TEXT NOT NULL CHECK(state IN ('pending','processing','applied','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 99),
 last_error TEXT,
 reason TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stream_visibility_pending ON stream_visibility(state,updated_at);
