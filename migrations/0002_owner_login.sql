-- P2 owner login throttle. One row per bucket; only failure counts and timestamps, never passwords or IPs.
CREATE TABLE IF NOT EXISTS login_failures (
  bucket TEXT PRIMARY KEY NOT NULL,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  window_started_at INTEGER NOT NULL
);
