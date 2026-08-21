-- D1 schema — specs.md §8.2. Phase 1 only needs the quota table (Tier 1 rate
-- limiting); plans/plan_versions land in Phase 2 alongside D1 plan persistence.
CREATE TABLE IF NOT EXISTS quota (
  bucket_key TEXT NOT NULL,              -- hash(client_id, ip) or 'GLOBAL'
  day        TEXT NOT NULL,              -- 'YYYY-MM-DD' UTC
  turns      INTEGER NOT NULL DEFAULT 0,
  neurons    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, day)
);
