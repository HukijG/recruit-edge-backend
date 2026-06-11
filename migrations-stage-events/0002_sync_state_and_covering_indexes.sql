-- Reconcile waterline state + covering partial indexes for the aggregate.
--
-- sync_state: one row per key. 'reconcile_waterline_ms' is the high-water
-- mark of the hourly sweep — every stage movement with entered_ms at or below
-- it has been ingested by a fully-successful sweep. The sweep re-reads a
-- fixed overlap below the waterline each run (RF's candidate/search index
-- lags ~1h; the overlap absorbs it), and only advances the mark when no
-- candidate in the window failed.
CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- Replace the (flag, entered_ms) indexes with covering partial indexes. The
-- two latest-event-wins aggregate queries filter WHERE <flag> = 1 and then
-- read candidate_id / job_id / entered_ms / mover_rf_id / entered_raw for the
-- window function — with the old non-covering shape every flagged index hit
-- also cost a table-row lookup (~2 rows_read per event, every recompute).
-- The partial covering shape serves the whole query from the index and only
-- indexes flagged rows, so write-side maintenance stays negligible.
DROP INDEX idx_stage_events_cv;
DROP INDEX idx_stage_events_iv;
CREATE INDEX idx_stage_events_cv ON stage_events
  (candidate_id, job_id, entered_ms, mover_rf_id, entered_raw)
  WHERE is_cv_cross = 1;
CREATE INDEX idx_stage_events_iv ON stage_events
  (candidate_id, job_id, entered_ms, mover_rf_id, entered_raw)
  WHERE is_iv_landing = 1;
