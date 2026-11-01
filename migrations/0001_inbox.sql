-- Single-owner P1 schema. Candidate text remains private in D1, never in public GitHub/Pages.
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination = 'food'),
  source TEXT NOT NULL CHECK (source IN ('manual','chatgpt','claude')),
  idempotency_key TEXT NOT NULL,
  meaning TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected','confirmed')),
  received_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE(owner_id,destination,source,idempotency_key)
);
CREATE INDEX IF NOT EXISTS inbox_owner_status_time ON inbox(owner_id,status,received_at);
CREATE TABLE IF NOT EXISTS inbox_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE RESTRICT,
  change_type TEXT NOT NULL CHECK (change_type IN ('created','status')),
  status TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
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
