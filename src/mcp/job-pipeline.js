/**
 * /mcp/job-pipeline — pre-shaped pipeline view for one job, KV-first.
 *
 * The sync-worker rebuilds `mcp:pipeline:{jobId}` snapshots in KV every tick
 * (see sync-worker/src/snapshots.js).  This handler reads that snapshot
 * directly when present and falls back to a live D1 build on cache miss
 * (writing the result back to KV with a 1h TTL — the next scheduled rebuild
 * will overwrite well before that fires).
 *
 * Filtering options:
 *   - `stage`     — narrow to a single stage by name
 *   - `submitted` — narrow to the post-CV-Sent stages (CV Sent → Hired)
 *
 * `stage` and `submitted` are mutually exclusive in practice: if both are
 * provided, `stage` wins (it's the more specific filter).
 *
 * Field projection follows the same alias-driven path as /mcp/candidate-search;
 * unresolved fields surface in `_meta.unresolved_fields`.
 */

import { jsonResponse } from './router.js';
import { session } from './d1-read.js';
import { resolveFields, project } from './projection.js';

const DEFAULT_FIELDS = ['id', 'name', 'stage_moved'];
const SUBMITTED_STAGES = [
  'CV Sent',
  '1st Interview',
  '2nd Interview',
  '3rd Interview',
  'Final Interview',
  'Offer',
  'Hired',
];

/**
 * Live-build the pipeline snapshot from D1 when KV misses.  Mirrors the shape
 * sync-worker writes to `mcp:pipeline:{jobId}`. Returns null if the job_id is
 * unknown so the caller can return 404.
 */
async function buildPipelineFromD1(env, jobId) {
  const meta = await session(env)
    .prepare('SELECT id, name, client_company_name FROM jobs WHERE id = ?')
    .bind(jobId)
    .first();
  if (!meta) return null;

  const { results } = await session(env)
    .prepare(
      `SELECT cj.candidate_id AS id, c.name, c.body, cj.stage_name, cj.stage_moved
       FROM candidate_jobs cj
       JOIN candidates c ON c.id = cj.candidate_id
       WHERE cj.job_id = ? AND cj.disqualified = 0
       ORDER BY cj.stage_name, c.name`,
    )
    .bind(jobId)
    .all();

  const stages = new Map();
  for (const r of results ?? []) {
    if (!stages.has(r.stage_name)) stages.set(r.stage_name, []);
    const body = JSON.parse(r.body || '{}');
    stages.get(r.stage_name).push({
      id: r.id,
      name: r.name,
      stage_moved: r.stage_moved,
      ...body,
    });
  }

  return {
    job: {
      id: meta.id,
      name: meta.name,
      client_company_name: meta.client_company_name,
    },
    stages: [...stages.entries()].map(([stage_name, candidates]) => ({
      stage_name,
      count: candidates.length,
      candidates,
    })),
  };
}

export async function handleJobPipeline({ env, body }) {
  const jobId = Number(body.job);
  if (!Number.isFinite(jobId)) {
    return jsonResponse(400, { error: 'job must be numeric id' });
  }

  // Try the pre-built KV snapshot first.
  let snap = null;
  const cached = await env.SYNC_STATE.get(`mcp:pipeline:${jobId}`);
  if (cached) snap = JSON.parse(cached);

  // Cache miss → build from D1, write back so subsequent reads hit KV.
  if (!snap) {
    snap = await buildPipelineFromD1(env, jobId);
    if (!snap) return jsonResponse(404, { error: 'unknown job' });
    await env.SYNC_STATE.put(
      `mcp:pipeline:${jobId}`,
      JSON.stringify(snap),
      { expirationTtl: 3600 },
    );
  }

  // Apply stage / submitted filters.  `stage` is the more specific filter and
  // wins when both are supplied (callers shouldn't pass both, but be lenient).
  let stages = snap.stages;
  if (body.stage) {
    stages = stages.filter((s) => s.stage_name === body.stage);
  } else if (body.submitted) {
    stages = stages.filter((s) => SUBMITTED_STAGES.includes(s.stage_name));
  }

  // Resolve requested fields against a representative candidate so custom
  // fields and aliases work the same as the candidate-search handler.
  const requested = body.fields ?? DEFAULT_FIELDS;
  const sample = stages[0]?.candidates?.[0] ?? {};
  const { paths, errors, notes } = resolveFields(requested, sample, sample);

  const projectedStages = stages.map((s) => ({
    stage_name: s.stage_name,
    count: s.count,
    candidates: s.candidates.map((c) => project(c, paths)),
  }));

  const response = { job: snap.job, stages: projectedStages };
  if (errors.length || notes.length) {
    response._meta = {};
    if (errors.length) response._meta.unresolved_fields = errors;
    if (notes.length) response._meta.notes = notes;
  }
  return jsonResponse(200, response);
}
