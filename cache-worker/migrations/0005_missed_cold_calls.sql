-- 0005_missed_cold_calls.sql — backfill store for historical cancelled / missed
-- cold calls that never reached RF.
-- Spec: the cancelled-cold-calls design.
--
-- Populated ONCE by scripts/backfill-cancelled-cold-calls.mjs for the owner
-- (Joel) across jobs 981/973/996 — Dialpad calls that rang but never connected
-- (and so produced no transcript, so the live cold-call flow never logged them).
-- The /candidate-details endpoint LEFT-joins this table for the owner only and
-- merges the rows into the cold-call activity list at read time. Forward-going
-- cancelled calls are written straight to RF as type-1002 activities, so this
-- table is historical-only and never overlaps RF.
--
-- Lives in RF_MCP_CACHE (cache-worker-owned). The main worker reads it only.
-- Immutable per the cache contract: one row per Dialpad call_id, never updated.

CREATE TABLE missed_cold_calls (
  call_id            TEXT PRIMARY KEY,
  rf_candidate_id    INTEGER NOT NULL,
  target_dialpad_id  TEXT NOT NULL,
  date_started_ms    INTEGER NOT NULL,
  outcome            TEXT NOT NULL,          -- 'cancelled' | 'voicemail' | 'connected'
  duration_ms        INTEGER,
  cached_at_ms       INTEGER NOT NULL
);

-- Per-candidate read path (the /candidate-details join). Without this the join
-- would full-scan the table on every owner fetch.
CREATE INDEX idx_missed_cold_calls_candidate
  ON missed_cold_calls (rf_candidate_id, date_started_ms DESC);
