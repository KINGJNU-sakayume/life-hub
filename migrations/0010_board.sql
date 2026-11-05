-- P7 stage B1: board manifests (docs/P7_BOARD.md section 5).
-- One row per (owner, app): the newest manifest the app published, replaced by each newer upload. The Hub
-- checks only storage and identity (src/board/checks.js); the board validates every tile before drawing.
-- body_json is the exact JSON text the app sent and is never logged or echoed in errors. generated_at is
-- stored normalized (toISOString) so that string comparison orders it. size_bytes counts UTF-8 bytes;
-- length() counts characters, so its CHECK is only a coarse guard and the code enforces the byte limit.

CREATE TABLE IF NOT EXISTS board_manifests (
  owner_id     TEXT    NOT NULL,
  app          TEXT    NOT NULL CHECK (length(app) BETWEEN 1 AND 40),
  generated_at TEXT    NOT NULL CHECK (length(generated_at) = 24),
  received_at  TEXT    NOT NULL,
  body_json    TEXT    NOT NULL CHECK (length(body_json) <= 65536),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes BETWEEN 2 AND 65536),
  sha256       TEXT    NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (owner_id, app)
);
