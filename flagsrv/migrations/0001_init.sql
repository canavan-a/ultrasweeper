-- +goose Up
CREATE TABLE flags (
  id         TEXT PRIMARY KEY,            -- ULID, stable forever
  flag       INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  local_only INTEGER NOT NULL DEFAULT 0,  -- 0 = from server anyway; kept for import
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE flag_matchers (
  flag_id TEXT NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('mac','name','company','service','eddy_uid','oui')),
  value   TEXT NOT NULL,
  PRIMARY KEY (flag_id, kind, value)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- 'revision' lives here
INSERT INTO meta VALUES ('revision','1');

-- +goose Down
DROP TABLE flag_matchers;
DROP TABLE flags;
DROP TABLE meta;
