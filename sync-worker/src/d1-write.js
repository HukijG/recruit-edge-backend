/**
 * d1-write.js — atomic D1 upsert helpers for candidates + candidate_jobs + jobs.
 *
 * D1's `batch([...])` runs all statements in a single implicit transaction, so
 * the (candidate row + DELETE FROM candidate_jobs + N link rows) for one
 * candidate are committed together or not at all. Atomicity per-candidate is
 * the load-bearing invariant: a partial write would leave job links pointing
 * at a stale candidate row, which `/mcp/*` reads would then surface as
 * inconsistent state.
 *
 * D1 caps each batch at 100 statements. We chunk batches at the candidate
 * boundary (never split a single candidate's statements across two batches),
 * flushing the in-flight batch before adding any candidate whose statements
 * would push the running total over 100.
 *
 * A candidate with >98 jobs would itself produce 1 + 1 + N > 100 statements,
 * which can't fit in one batch and therefore can't be written atomically. We
 * surface that as a thrown error rather than silently splitting.
 */

import {
  toCandidateRow,
  toCandidateJobRows,
  toCandidateThinRow,
  toJobThinRow,
  toCallRow,
} from './normalize.js';

const CAND_COLS = [
  'id', 'body', 'name', 'primary_email', 'linkedin_profile',
  'current_organization', 'current_title', 'lead_owner_id',
  'added_time', 'last_updated', 'last_activity_at', 'cached_at',
];

const CJ_COLS = [
  'candidate_id', 'job_id', 'stage_id', 'stage_name',
  'stage_moved', 'added_to_job', 'added_to_job_by_id',
  'disqualified', 'disqualification_reason',
];

const JOB_COLS = ['id', 'body', 'name', 'client_company_name', 'is_open', 'cached_at'];

const candPlaceholders = CAND_COLS.map(() => '?').join(', ');
const cjPlaceholders   = CJ_COLS.map(() => '?').join(', ');
const jobPlaceholders  = JOB_COLS.map(() => '?').join(', ');

const CAND_INSERT_SQL = `INSERT OR REPLACE INTO candidates (${CAND_COLS.join(', ')}) VALUES (${candPlaceholders})`;
const CJ_DELETE_SQL   = `DELETE FROM candidate_jobs WHERE candidate_id = ?`;
const CJ_INSERT_SQL   = `INSERT INTO candidate_jobs (${CJ_COLS.join(', ')}) VALUES (${cjPlaceholders})`;
const JOB_INSERT_SQL  = `INSERT OR REPLACE INTO jobs (${JOB_COLS.join(', ')}) VALUES (${jobPlaceholders})`;

const D1_BATCH_CAP = 100;

/**
 * Build the (candidate row + DELETE + N link rows) statements for one RF
 * candidate. Returned as a single array — callers MUST keep these statements
 * together in the same batch to preserve atomicity.
 */
function buildCandidateStatements(env, rf) {
  const row = toCandidateRow(rf);
  const links = toCandidateJobRows(rf);

  const stmts = [];
  stmts.push(
    env.RF_MCP_CACHE.prepare(CAND_INSERT_SQL).bind(...CAND_COLS.map(c => row[c]))
  );
  stmts.push(
    env.RF_MCP_CACHE.prepare(CJ_DELETE_SQL).bind(row.id)
  );
  for (const link of links) {
    stmts.push(
      env.RF_MCP_CACHE.prepare(CJ_INSERT_SQL).bind(...CJ_COLS.map(c => link[c]))
    );
  }
  return stmts;
}

/**
 * Atomically upsert RF candidates and their job-link rows.
 *
 * Per candidate: 1 candidates row + 1 DELETE + N candidate_jobs inserts, all
 * committed in the same `db.batch([...])` call. Batches are flushed at the
 * candidate boundary so a single candidate is never split across batches.
 *
 * @param {object} env  - Worker env with `RF_MCP_CACHE` D1 binding
 * @param {Array<object>} rfCandidates - canonical RF candidate objects
 * @throws if a single candidate's statement count exceeds the D1 batch cap
 */
export async function writeCandidatesAndLinks(env, rfCandidates) {
  if (!rfCandidates?.length) return;

  let batch = [];
  for (const rf of rfCandidates) {
    const candStmts = buildCandidateStatements(env, rf);

    if (candStmts.length > D1_BATCH_CAP) {
      // Atomicity is non-negotiable per-candidate. A candidate producing
      // >100 statements (i.e. >98 jobs) cannot be written atomically because
      // D1's batch cap is 100. Surface this loudly rather than silently
      // splitting the candidate across two non-atomic batches.
      throw new Error(
        `writeCandidatesAndLinks: candidate ${rf?.id} produces ${candStmts.length} ` +
        `statements (>100 D1 batch cap); cannot write atomically`
      );
    }

    if (batch.length + candStmts.length > D1_BATCH_CAP) {
      // Flushing now keeps the next candidate's full statement set together
      // in a fresh batch — never splits a candidate across batches.
      await env.RF_MCP_CACHE.batch(batch);
      batch = [];
    }

    batch.push(...candStmts);
  }

  if (batch.length) {
    await env.RF_MCP_CACHE.batch(batch);
  }
}

/**
 * Upsert jobs into the `jobs` table. INSERT OR REPLACE semantics — existing
 * rows by `id` are overwritten wholesale.
 *
 * @param {object} env  - Worker env with `RF_MCP_CACHE` D1 binding
 * @param {Array<object>} jobs - canonical RF job objects (must have `id`)
 */
export async function writeJobs(env, jobs) {
  if (!jobs?.length) return;
  const now = new Date().toISOString();
  const stmts = jobs.map(j =>
    env.RF_MCP_CACHE.prepare(JOB_INSERT_SQL).bind(
      j.id,
      JSON.stringify(j),
      j.name ?? null,
      // RF /job/list returns the client company nested as `company: {id, name}`.
      // /candidate/get's jobs[] uses `client_company_name` directly. Accept both.
      j.client_company_name ?? j.company?.name ?? null,
      j.is_open ? 1 : 0,
      now,
    )
  );
  for (let i = 0; i < stmts.length; i += D1_BATCH_CAP) {
    await env.RF_MCP_CACHE.batch(stmts.slice(i, i + D1_BATCH_CAP));
  }
}

const JP_COLS = ['job_id', 'summary_json', 'stage_candidates_json', 'fetched_at'];
const JP_INSERT_SQL = `INSERT OR REPLACE INTO job_pipelines (${JP_COLS.join(', ')}) VALUES (?, ?, ?, ?)`;

/**
 * Upsert one job's pipeline cache row.
 *
 * @param {object} env
 * @param {number} jobId
 * @param {Array} summary - RF /job/pipeline summary[] verbatim
 * @param {Object<string, number[]>} stageCandidates - per-stage active-candidate ids (DQ excluded)
 */
export async function writeJobPipeline(env, jobId, summary, stageCandidates) {
  const now = new Date().toISOString();
  await env.RF_MCP_CACHE
    .prepare(JP_INSERT_SQL)
    .bind(jobId, JSON.stringify(summary ?? []), JSON.stringify(stageCandidates ?? {}), now)
    .run();
}

// ---------------------------------------------------------------------------
// THIN-IMMUTABLE writers — INSERT OR IGNORE (first write wins).
// These target candidates_v2, jobs_v2, and calls from migration 0003.
// ---------------------------------------------------------------------------

const CAND_V2_COLS = [
  'id', 'name', 'linkedin_profile', 'added_time_ms',
  'current_title_at_cache_time', 'current_company_at_cache_time', 'cached_at_ms',
];
const JOBS_V2_COLS = [
  'id', 'name', 'client_company_name', 'added_time_ms',
  'canonical_pipeline_json', 'cached_at_ms',
];
const CALLS_COLS = [
  'call_id', 'target_dialpad_id', 'dialpad_contact_id', 'rf_candidate_id',
  'date_started_ms', 'duration_ms', 'direction', 'cached_at_ms',
];

const candV2Placeholders = CAND_V2_COLS.map(() => '?').join(', ');
const jobsV2Placeholders = JOBS_V2_COLS.map(() => '?').join(', ');
const callsPlaceholders  = CALLS_COLS.map(() => '?').join(', ');

const CAND_V2_SQL = `INSERT OR IGNORE INTO candidates_v2 (${CAND_V2_COLS.join(', ')}) VALUES (${candV2Placeholders})`;
const JOBS_V2_SQL = `INSERT OR IGNORE INTO jobs_v2 (${JOBS_V2_COLS.join(', ')}) VALUES (${jobsV2Placeholders})`;
const CALLS_SQL   = `INSERT OR IGNORE INTO calls (${CALLS_COLS.join(', ')}) VALUES (${callsPlaceholders})`;

/**
 * Batch-insert rows using INSERT OR IGNORE into the given table.
 * On PK collision the existing row is preserved (first write wins).
 * Chunks at D1_BATCH_CAP (100) — no atomicity requirement here since each row
 * is self-contained.
 *
 * @param {object} env
 * @param {string} sql - prepared INSERT OR IGNORE SQL
 * @param {Array<object>} rows - already-normalised row objects
 * @param {string[]} cols - ordered column names matching SQL placeholders
 */
async function batchInsert(env, sql, rows, cols) {
  if (!rows?.length) return;
  const stmts = rows.map(row =>
    env.RF_MCP_CACHE.prepare(sql).bind(...cols.map(c => row[c] ?? null))
  );
  for (let i = 0; i < stmts.length; i += D1_BATCH_CAP) {
    await env.RF_MCP_CACHE.batch(stmts.slice(i, i + D1_BATCH_CAP));
  }
}

/**
 * Build normalized rows from raw RF inputs, skipping (and structured-logging)
 * any single input whose `builderFn` throws.
 *
 * Per-row resilience is load-bearing: a malformed RF row in a 5000-row batch
 * must NOT abort the entire batch — otherwise the cursor doesn't advance, the
 * next tick re-fetches the same page, and the same bad row crashes again on
 * every tick forever (loss of forward progress).
 *
 * @param {Array<object>} rfRows - raw RF objects
 * @param {Function} builderFn   - row builder; may throw
 * @param {string} fn            - builder name for structured log
 * @returns {Array<object>}      - successfully-built rows (length <= rfRows.length)
 */
function buildRowsResilient(rfRows, builderFn, fn) {
  if (!rfRows?.length) return [];
  const out = [];
  for (const r of rfRows) {
    try {
      out.push(builderFn(r));
    } catch (e) {
      console.warn({
        message: `[d1-write] skip_row fn=${fn} rfId=${r?.id} error=${e?.message}`,
        source: 'd1-write', fn, op: 'skip_row',
        error: e?.message ?? String(e), rfId: r?.id ?? null,
      });
    }
  }
  return out;
}

/**
 * INSERT OR IGNORE candidates into candidates_v2.
 * Re-running with the same RF candidates is safe — existing rows are not
 * overwritten (immutable-cache contract).
 *
 * Per-row resilience: a malformed RF row (e.g. missing `added_time`) emits a
 * structured `skip_row` log line and is omitted from the batch; the rest of
 * the batch still lands. An entirely empty batch (all rows skipped) is a no-op
 * — no D1 write attempted.
 *
 * @param {object} env - Worker env with `RF_MCP_CACHE` D1 binding
 * @param {Array<object>} rfCandidates - RF candidate-shaped objects
 */
export async function writeCandidatesThin(env, rfCandidates) {
  const rows = buildRowsResilient(rfCandidates, toCandidateThinRow, 'toCandidateThinRow');
  await batchInsert(env, CAND_V2_SQL, rows, CAND_V2_COLS);
}

/**
 * INSERT OR IGNORE jobs into jobs_v2.
 * If `opts.pipelineByJobId` (Map<id, stage[]>) is provided, the
 * `canonical_pipeline_json` column is populated for matching job ids.
 *
 * Per-row resilience: a malformed RF job (e.g. missing all of `created_time` /
 * `added_time` / `date_created`) emits a structured `skip_row` log and is
 * omitted; the rest of the batch still lands.
 *
 * @param {object} env
 * @param {Array<object>} rfJobs - RF job-shaped objects
 * @param {{ pipelineByJobId?: Map<number, Array> }} [opts]
 */
export async function writeJobsThin(env, rfJobs, opts = {}) {
  const pipelineByJobId = opts.pipelineByJobId ?? new Map();
  // Wrap toJobThinRow so the pipeline lookup runs inside the resilient try/catch
  // (a thrown row never reaches the lookup either, so this is purely structural
  // — the Map.get is cheap and side-effect-free).
  const builder = (j) => {
    const row = toJobThinRow(j);
    const summary = pipelineByJobId.get(j.id);
    if (summary) row.canonical_pipeline_json = JSON.stringify(summary);
    return row;
  };
  const rows = buildRowsResilient(rfJobs, builder, 'toJobThinRow');
  await batchInsert(env, JOBS_V2_SQL, rows, JOBS_V2_COLS);
}

/**
 * INSERT OR IGNORE Dialpad calls into the `calls` table.
 * Accepts Dialpad /v2/call list items or hangup webhook payloads.
 *
 * Per-row resilience: a malformed Dialpad row (e.g. missing `target.id` or
 * `call_id`) emits a structured `skip_row` log and is omitted; the rest still
 * lands.
 *
 * @param {object} env
 * @param {Array<object>} dialpadCalls
 */
export async function writeCalls(env, dialpadCalls) {
  const rows = buildRowsResilient(dialpadCalls, toCallRow, 'toCallRow');
  await batchInsert(env, CALLS_SQL, rows, CALLS_COLS);
}
