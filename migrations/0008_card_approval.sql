-- P4: Claude conversation cards (MCP Apps).
-- 1) New inbox status `approved`: the owner approved the candidate in a Claude card; the destination
--    app has not saved it yet. Only the app's receipt makes it `confirmed`.
--    Edits made in the card go to final_payload_json; envelope_json (the original proposal) is kept.
--    revision is an optimistic lock for edits/approval; needs_app_review asks the app for a last check.
-- 2) card_tickets: single-use approval tickets handed only to the card UI (hash stored, never the ticket).
-- 3) destination_refs: small reference lists an app publishes for card pickers (regions, categories …).
-- Same table rebuild as 0006/0007; every row, receipt, event and trigger is kept.

CREATE TABLE inbox_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 40),
  source TEXT NOT NULL CHECK (source IN ('manual','chatgpt','claude','codex','spotify')),
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
INSERT INTO inbox_new (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at,reviewed_at,confirmed_entity_id)
  SELECT id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at,reviewed_at,confirmed_entity_id FROM inbox;

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
  VALUES (NEW.owner_id,NEW.id,'status',NEW.status,COALESCE(NEW.reviewed_at,NEW.approved_at,NEW.received_at));
END;
CREATE TRIGGER IF NOT EXISTS inbox_edit_event AFTER UPDATE OF revision ON inbox
WHEN NEW.revision > OLD.revision
BEGIN
  INSERT INTO inbox_changes (owner_id,candidate_id,change_type,status,changed_at)
  VALUES (NEW.owner_id,NEW.id,'edited',NEW.status,COALESCE(NEW.edited_at,NEW.received_at));
END;

CREATE TABLE IF NOT EXISTS card_tickets (
  ticket_hash TEXT PRIMARY KEY NOT NULL CHECK (length(ticket_hash) = 64),
  owner_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_for TEXT CHECK (used_for IS NULL OR used_for IN ('approve','reject'))
);
CREATE INDEX IF NOT EXISTS card_tickets_expiry ON card_tickets(expires_at);

CREATE TABLE IF NOT EXISTS destination_refs (
  owner_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  body_json TEXT NOT NULL CHECK (length(body_json) <= 32768),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, destination, kind)
);
