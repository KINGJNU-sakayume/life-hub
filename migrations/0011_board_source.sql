-- P7 stage B5: proposals sent by Life Board (docs/P7_BOARD.md section 8) get their own inbox source `board`.
-- SQLite needs a table rebuild to change the source CHECK (same pattern as 0006/0007/0008). Every proposal, event,
-- card ticket, index and trigger is kept. Children are rebuilt first and pointed at inbox_new, so dropping the old
-- tables never cascades (card_tickets is ON DELETE CASCADE) and never trips inbox_changes' RESTRICT.

CREATE TABLE inbox_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 40),
  source TEXT NOT NULL CHECK (source IN ('manual','chatgpt','claude','codex','spotify','board')),
  idempotency_key TEXT NOT NULL,
  meaning TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','confirmed')),
  received_at TEXT NOT NULL,
  reviewed_at TEXT,
  confirmed_entity_id TEXT,
  final_payload_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  edited_at TEXT,
  approved_at TEXT,
  needs_app_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_app_review IN (0,1)),
  UNIQUE(owner_id,destination,source,idempotency_key)
);
INSERT INTO inbox_new (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at,reviewed_at,
  confirmed_entity_id,final_payload_json,revision,edited_at,approved_at,needs_app_review)
  SELECT id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at,reviewed_at,
  confirmed_entity_id,final_payload_json,revision,edited_at,approved_at,needs_app_review FROM inbox;

CREATE TABLE inbox_changes_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES inbox_new(id) ON DELETE RESTRICT,
  change_type TEXT NOT NULL CHECK (change_type IN ('created','status','edited')),
  status TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
INSERT INTO inbox_changes_new (seq,owner_id,candidate_id,change_type,status,changed_at)
  SELECT seq,owner_id,candidate_id,change_type,status,changed_at FROM inbox_changes;

CREATE TABLE card_tickets_new (
  ticket_hash TEXT PRIMARY KEY NOT NULL CHECK (length(ticket_hash) = 64),
  owner_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES inbox_new(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_for TEXT CHECK (used_for IS NULL OR used_for IN ('approve','reject'))
);
INSERT INTO card_tickets_new (ticket_hash,owner_id,candidate_id,created_at,expires_at,used_at,used_for)
  SELECT ticket_hash,owner_id,candidate_id,created_at,expires_at,used_at,used_for FROM card_tickets;

DROP TABLE card_tickets;
DROP TABLE inbox_changes;
DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;
ALTER TABLE inbox_changes_new RENAME TO inbox_changes;
ALTER TABLE card_tickets_new RENAME TO card_tickets;

CREATE INDEX IF NOT EXISTS inbox_owner_status_time ON inbox(owner_id,status,received_at);
CREATE INDEX IF NOT EXISTS inbox_changes_owner_seq ON inbox_changes(owner_id,seq);
CREATE INDEX IF NOT EXISTS card_tickets_expiry ON card_tickets(expires_at);
CREATE TRIGGER IF NOT EXISTS inbox_insert_event AFTER INSERT ON inbox
BEGIN
  INSERT INTO inbox_changes (owner_id,candidate_id,change_type,status,changed_at)
  VALUES (NEW.owner_id,NEW.id,'created',NEW.status,NEW.received_at);
END;
CREATE TRIGGER IF NOT EXISTS inbox_status_event AFTER UPDATE OF status ON inbox
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO inbox_changes (owner_id,candidate_id,change_type,status,changed_at)
  VALUES (NEW.owner_id,NEW.id,'status',NEW.status,COALESCE(NEW.reviewed_at,NEW.approved_at,NEW.received_at));
END;
CREATE TRIGGER IF NOT EXISTS inbox_edit_event AFTER UPDATE OF revision ON inbox
WHEN NEW.revision > OLD.revision
BEGIN
  INSERT INTO inbox_changes (owner_id,candidate_id,change_type,status,changed_at)
  VALUES (NEW.owner_id,NEW.id,'edited',NEW.status,COALESCE(NEW.edited_at,NEW.received_at));
END;
