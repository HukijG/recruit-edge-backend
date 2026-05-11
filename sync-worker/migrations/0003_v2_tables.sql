-- 0003_v2_tables.sql — thin-immutable cache (rev 5 design).
-- Spec: the thin-immutable cache design (2026-05-11).
--
-- Coexists with the legacy candidates / candidate_jobs / jobs / job_pipelines
-- tables during the dual-write cutover; legacy tables are dropped in 0004.

CREATE TABLE candidates_v2 (
  id                              INTEGER PRIMARY KEY,
  name                            TEXT,
  linkedin_profile                TEXT,
  added_time_ms                   INTEGER NOT NULL,
  current_title_at_cache_time     TEXT,
  current_company_at_cache_time   TEXT,
  cached_at_ms                    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_candidates_v2_linkedin
  ON candidates_v2 (linkedin_profile)
  WHERE linkedin_profile IS NOT NULL;
CREATE INDEX idx_candidates_v2_added_time
  ON candidates_v2 (added_time_ms DESC);

CREATE TABLE jobs_v2 (
  id                       INTEGER PRIMARY KEY,
  name                     TEXT,
  client_company_name      TEXT,
  added_time_ms            INTEGER NOT NULL,
  canonical_pipeline_json  TEXT,
  cached_at_ms             INTEGER NOT NULL
);
CREATE INDEX idx_jobs_v2_company
  ON jobs_v2 (client_company_name);
CREATE INDEX idx_jobs_v2_added_time
  ON jobs_v2 (added_time_ms DESC);

CREATE TABLE calls (
  call_id              TEXT PRIMARY KEY,
  target_dialpad_id    TEXT NOT NULL,
  dialpad_contact_id   TEXT,
  rf_candidate_id      INTEGER,
  date_started_ms      INTEGER NOT NULL,
  duration_ms          INTEGER,
  direction            TEXT,
  cached_at_ms         INTEGER NOT NULL
);
CREATE INDEX idx_calls_target_candidate_started
  ON calls (target_dialpad_id, rf_candidate_id, date_started_ms DESC)
  WHERE rf_candidate_id IS NOT NULL;
CREATE INDEX idx_calls_target_started
  ON calls (target_dialpad_id, date_started_ms DESC);
