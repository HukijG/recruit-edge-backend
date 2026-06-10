-- Stage-movement event log (STAGE_EVENTS D1, database rf-stage-events).
-- Append-only, idempotent: one row per RF stage transition, identified by
-- (candidate_id, job_id, entered_raw). entered_raw is RF's verbatim timestamp
-- string — never normalised; it is the dedup identity. Classification flags
-- (is_cv_cross / is_iv_landing) are denormalised at write time from
-- src/stage-stats/classify.js; a label change requires a backfill re-run to
-- recompute them (ON CONFLICT updates flags in place).
CREATE TABLE stage_events (
  candidate_id   INTEGER NOT NULL,
  job_id         INTEGER NOT NULL,
  entered_raw    TEXT    NOT NULL,  -- RF's verbatim timestamp string; identity component
  entered_ms     INTEGER NOT NULL,  -- parsed UTC epoch ms
  from_stage     TEXT,              -- NULL when RF omits it
  to_stage       TEXT    NOT NULL,
  mover_rf_id    INTEGER,           -- stage_moved_by.id; NULL when absent
  is_cv_cross    INTEGER NOT NULL,  -- 1 = crossed into submitted territory
  is_iv_landing  INTEGER NOT NULL,  -- 1 = landed on a 1st-interview stage
  source         TEXT    NOT NULL,  -- 'webhook' | 'reconcile' | 'backfill'
  first_seen_ms  INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, job_id, entered_raw)
);
CREATE INDEX idx_stage_events_cv ON stage_events (is_cv_cross, entered_ms);
CREATE INDEX idx_stage_events_iv ON stage_events (is_iv_landing, entered_ms);
