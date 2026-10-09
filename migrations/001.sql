CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
  value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL, topic TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), dispatched INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0),
  actual REAL, settled INTEGER NOT NULL DEFAULT 0, unknown INTEGER NOT NULL DEFAULT 0
);
PRAGMA user_version=1;
