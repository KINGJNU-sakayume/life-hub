-- P6: device sync (docs/P6_SYNC.md).
-- One append-only list of versions per (owner, destination). The newest version is the current document;
-- older versions are kept (the registry's `keep`, default 10) for recovery. A write inserts version N+1
-- only if N is still the newest (a compare-and-swap in one statement); the primary key is the safety net
-- if two writers race. body_json is the exact JSON text the app sent: it is never logged or echoed in errors.
-- size_bytes counts UTF-8 bytes (D1 limits a row to 2,000,000 bytes); length() counts characters, so the
-- second CHECK is only a coarse guard and the code enforces the byte limit.

CREATE TABLE IF NOT EXISTS sync_docs (
  owner_id    TEXT    NOT NULL,
  destination TEXT    NOT NULL CHECK (length(destination) BETWEEN 1 AND 40),
  version     INTEGER NOT NULL CHECK (version >= 1),
  body_json   TEXT    NOT NULL CHECK (length(body_json) <= 1048576),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes BETWEEN 2 AND 1048576),
  sha256      TEXT    NOT NULL CHECK (length(sha256) = 64),
  device      TEXT    CHECK (device IS NULL OR length(device) <= 40),
  written_at  TEXT    NOT NULL,
  PRIMARY KEY (owner_id, destination, version)
);
