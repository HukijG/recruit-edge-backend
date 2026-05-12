CREATE TABLE job_pipelines (
  job_id INTEGER PRIMARY KEY,
  summary_json TEXT NOT NULL,
  stage_candidates_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_job_pipelines_fetched ON job_pipelines(fetched_at);
