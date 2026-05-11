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

import { toCandidateRow, toCandidateJobRows } from './normalize.js';

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
      console.log({ source: 'd1-write', table: 'candidates', op: 'replace', row_count: batch.length });
      batch = [];
    }

    batch.push(...candStmts);
  }

  if (batch.length) {
    await env.RF_MCP_CACHE.batch(batch);
    console.log({ source: 'd1-write', table: 'candidates', op: 'replace', row_count: batch.length });
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
    const chunk = stmts.slice(i, i + D1_BATCH_CAP);
    await env.RF_MCP_CACHE.batch(chunk);
    console.log({ source: 'd1-write', table: 'jobs', op: 'replace', row_count: chunk.length });
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
  console.log({ source: 'd1-write', table: 'job_pipelines', op: 'replace', row_count: 1 });
}
