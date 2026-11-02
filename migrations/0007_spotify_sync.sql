-- P3: Spotify listening sync for potcast.
-- 1) Allow the `spotify` candidate source (album sessions the hub collected from the owner's Spotify
--    recently-played list). Same table rebuild as 0006; every row, receipt, event and trigger is kept.
-- 2) spotify_link: one Spotify authorization per owner; the refresh token is stored encrypted
--    (AES-GCM, key from the HUB_SPOTIFY_TOKEN_KEY secret), never in plain text.
-- 3) spotify_plays: album-context plays waiting to be grouped into sessions; deleted as soon as a
--    session is turned into a candidate or discarded, and after 3 days at the latest.

CREATE TABLE inbox_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 40),
  source TEXT NOT NULL CHECK (source IN ('manual','chatgpt','claude','codex','spotify')),
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

CREATE TABLE IF NOT EXISTS spotify_link (
  owner_id TEXT PRIMARY KEY NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  cursor_ms INTEGER,
  last_polled_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS spotify_plays (
  owner_id TEXT NOT NULL,
  played_at TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  album_id TEXT NOT NULL,
  album_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  album_tracks INTEGER,
  PRIMARY KEY (owner_id, played_at, track_id)
);
CREATE INDEX IF NOT EXISTS spotify_plays_owner_time ON spotify_plays(owner_id, played_at);
