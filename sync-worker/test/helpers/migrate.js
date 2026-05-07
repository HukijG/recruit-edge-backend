/**
 * Test helper: apply the migration schema to the test D1 database.
 *
 * Uses db.prepare().run() for each statement so the helper works correctly
 * inside the Workers runtime (exec() has quirks with multi-line statements).
 *
 * DROP TABLE / DROP INDEX statements are issued first so the helper is safe
 * to call multiple times (once per test via beforeEach).
 *
 * The actual migrations/0001_init.sql is unchanged — this is test-only.
 * If you update 0001_init.sql, update the arrays below to match.
 */

const DROP_STMTS = [
  'DROP INDEX IF EXISTS idx_candidates_email',
  'DROP INDEX IF EXISTS idx_candidates_linkedin',
  'DROP INDEX IF EXISTS idx_candidates_lead_owner',
  'DROP INDEX IF EXISTS idx_candidates_last_updated',
  'DROP INDEX IF EXISTS idx_candidates_added_time',
  'DROP TABLE IF EXISTS candidates',
  'DROP INDEX IF EXISTS idx_cj_job_stage_dq',
  'DROP INDEX IF EXISTS idx_cj_added_by',
  'DROP INDEX IF EXISTS idx_cj_job_added',
  'DROP TABLE IF EXISTS candidate_jobs',
  'DROP INDEX IF EXISTS idx_jobs_open',
  'DROP TABLE IF EXISTS jobs',
  'DROP TABLE IF EXISTS sync_state',
];

const CREATE_STMTS = [
  `CREATE TABLE candidates (
    id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    name TEXT,
    primary_email TEXT,
    linkedin_profile TEXT,
    current_organization TEXT,
    current_title TEXT,
    lead_owner_id INTEGER,
    added_time TEXT,
    last_updated TEXT,
    last_activity_at TEXT,
    cached_at TEXT NOT NULL
  )`,
  'CREATE INDEX idx_candidates_email        ON candidates(primary_email)',
  'CREATE INDEX idx_candidates_linkedin     ON candidates(linkedin_profile)',
  'CREATE INDEX idx_candidates_lead_owner   ON candidates(lead_owner_id)',
  'CREATE INDEX idx_candidates_last_updated ON candidates(last_updated)',
  'CREATE INDEX idx_candidates_added_time   ON candidates(added_time)',
  `CREATE TABLE candidate_jobs (
    candidate_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    stage_id INTEGER,
    stage_name TEXT,
    stage_moved TEXT,
    added_to_job TEXT,
    added_to_job_by_id INTEGER,
    disqualified INTEGER NOT NULL,
    disqualification_reason TEXT,
    PRIMARY KEY (candidate_id, job_id)
  )`,
  'CREATE INDEX idx_cj_job_stage_dq ON candidate_jobs(job_id, disqualified, stage_name)',
  'CREATE INDEX idx_cj_added_by     ON candidate_jobs(added_to_job_by_id, job_id)',
  'CREATE INDEX idx_cj_job_added    ON candidate_jobs(job_id, added_to_job)',
  `CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    name TEXT,
    client_company_name TEXT,
    is_open INTEGER,
    cached_at TEXT NOT NULL
  )`,
  'CREATE INDEX idx_jobs_open ON jobs(is_open)',
  `CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/**
 * Apply migration schema to the given D1 database instance.
 * Drops all tables/indexes first so it is safe to call repeatedly.
 *
 * @param {D1Database} db - e.g. env.RF_MCP_CACHE
 */
export async function applyMigration(db) {
  for (const stmt of DROP_STMTS) {
    await db.prepare(stmt).run();
  }
  for (const stmt of CREATE_STMTS) {
    await db.prepare(stmt).run();
  }
}
