-- R4 staging migration. Must be applied to a separate D1 database after 0001 and 0002.
CREATE TABLE IF NOT EXISTS media_assets (
 id TEXT PRIMARY KEY,
 day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 10),
 title TEXT NOT NULL,
 file_name TEXT NOT NULL,
 stream_uid TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('pendingupload','processing','ready','error')),
 review_status TEXT NOT NULL CHECK(review_status IN ('pending','approved')),
 rights_ref TEXT,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 checked_at TEXT,
 approved_by TEXT,
 approved_at TEXT,
 caption_lang TEXT,
 chapters_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS media_day_idx ON media_assets(day,review_status);
CREATE TABLE IF NOT EXISTS editorial_versions (
 version INTEGER PRIMARY KEY,
 public_json TEXT NOT NULL,
 reviewed_by TEXT NOT NULL,
 reviewed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS episode_calendar (
 day INTEGER PRIMARY KEY CHECK(day BETWEEN 1 AND 10),
 title TEXT NOT NULL,
 publish_at TEXT NOT NULL,
 checklist_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('planned','approved','released','cancelled')) DEFAULT 'planned',
 revision INTEGER NOT NULL DEFAULT 1,
 updated_by TEXT NOT NULL,
 approved_by TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_due_idx ON episode_calendar(status,publish_at);

CREATE TABLE IF NOT EXISTS editorial_restore_notes (
 id TEXT PRIMARY KEY,
 source_version INTEGER NOT NULL,
 restored_version INTEGER NOT NULL,
 actor TEXT NOT NULL,
 reason TEXT NOT NULL,
 at TEXT NOT NULL
);
