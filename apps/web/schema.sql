-- D1 schema — specs.md §8.2.
CREATE TABLE IF NOT EXISTS quota (
  bucket_key TEXT NOT NULL,              -- hash(client_id, ip) or 'GLOBAL'
  day        TEXT NOT NULL,              -- 'YYYY-MM-DD' UTC
  turns      INTEGER NOT NULL DEFAULT 0,
  neurons    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, day)
);

-- Phase 2: plan persistence and share links (FR-13, FR-14, FR-15).
-- `doc` is opaque text — the Worker never parses it (ARC-1).
-- All three token columns hold SHA-256 hashes, never the tokens themselves (SEC-3).
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT PRIMARY KEY,
  owner_hash       TEXT NOT NULL,
  edit_token_hash  TEXT,
  share_token_hash TEXT,
  title            TEXT NOT NULL DEFAULT 'Untitled',
  schema_version   INTEGER NOT NULL,
  doc              TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_owner ON plans(owner_hash, updated_at DESC);

CREATE TABLE IF NOT EXISTS plan_versions (
  plan_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  patch      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, seq)
);
