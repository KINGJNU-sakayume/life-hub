-- P3: drop the destination CHECK. Destinations are validated by the adapter registry (src/adapters/index.js)
-- before any insert, so adding a site no longer needs a table rebuild. Same safe rebuild as 0004: the new
-- change log references inbox_new and the rename rewrites it; history and sequence numbers are preserved.

CREATE TABLE inbox_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 40),
  source TEXT NOT NULL CHECK (source IN ('manual','chatgpt','claude')),
  idempotency_key TEXT NOT NULL,
  meaning TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected','confirmed')),
  received_at TEXT NOT NULL,
  reviewed_at TEXT,
  confirmed_entity_id TEXT,
  UNIQUE(owner_id,destination,source,idempotency_key)
);
INSERT INTO inbox_new (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at,reviewed_at,confirmed_entity_id)
  SELECT id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at,reviewed_at,confirmed_entity_id FROM inbox;

CREATE TABLE inbox_changes_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES inbox_new(id) ON DELETE RESTRICT,
  change_type TEXT NOT NULL CHECK (change_type IN ('created','status')),
  status TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
INSERT INTO inbox_changes_new (seq,owner_id,candidate_id,change_type,status,changed_at)
  SELECT seq,owner_id,candidate_id,change_type,status,changed_at FROM inbox_changes;

DROP TABLE inbox_changes;
DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;
ALTER TABLE inbox_changes_new RENAME TO inbox_changes;

CREATE INDEX IF NOT EXISTS inbox_owner_status_time ON inbox(owner_id,status,received_at);
CREATE INDEX IF NOT EXISTS inbox_changes_owner_seq ON inbox_changes(owner_id,seq);
CREATE TRIGGER IF NOT EXISTS inbox_insert_event AFTER INSERT ON inbox
BEGIN
  INSERT INTO inbox_changes (owner_id,candidate_id,change_type,status,changed_at)
  VALUES (NEW.owner_id,NEW.id,'created',NEW.status,NEW.received_at);
END;
CREATE TRIGGER IF NOT EXISTS inbox_status_event AFTER UPDATE OF status ON inbox
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO inbox_changes (owner_id,candidate_id,change_type,status,changed_at)
  VALUES (NEW.owner_id,NEW.id,'status',NEW.status,COALESCE(NEW.reviewed_at,NEW.received_at));
END;
