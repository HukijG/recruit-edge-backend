/**
 * /mcp/job-candidates-filter — flat candidate list for one job, KV-first.
 *
 * Reads the `mcp:job-candidates:{jobId}` snapshot written by sync-worker on
 * every rebuild tick.  On cache miss, falls back to a live D1 join and writes
 * the result back to KV (1h TTL — the scheduled rebuild will overwrite first).
 *
 * Optional filters:
 *   - `stage` — narrow to a single stage by name
 *   - `limit` — caps the returned `matched` array (default 100, hard max 500).
 *               When the total exceeds `limit`, `truncated: true` is returned.
 */

import { jsonResponse } from './router.js';
import { session } from './d1-read.js';
import { resolveFields, project } from './projection.js';
import { resolveJob, resolveStage, disambiguationPayload } from './resolvers.js';

const DEFAULT_FIELDS = ['id', 'name', 'stage_name'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Live-build the flat list snapshot from D1 when KV misses.  Mirrors the shape
 * sync-worker writes to `mcp:job-candidates:{jobId}`. Returns null on unknown
 * job_id so the caller can 404.
 */
async function buildListFromD1(env, jobId) {
  const meta = await session(env)
    .prepare('SELECT id, name FROM jobs WHERE id = ?')
    .bind(jobId)
    .first();
  if (!meta) return null;

  const { results } = await session(env)
    .prepare(
      `SELECT cj.candidate_id AS id, c.name, c.body, cj.stage_name, cj.stage_moved
       FROM candidate_jobs cj
       JOIN candidates c ON c.id = cj.candidate_id
       WHERE cj.job_id = ? AND cj.disqualified = 0
       ORDER BY c.name ASC`,
    )
    .bind(jobId)
    .all();

  const matched = (results ?? []).map((r) => {
    const body = JSON.parse(r.body || '{}');
    return {
      id: r.id,
      name: r.name,
      stage_name: r.stage_name,
      stage_moved: r.stage_moved,
      ...body,
    };
  });

  return {
    job: { id: meta.id, name: meta.name },
    total: matched.length,
    matched,
  };
}

export async function handleJobCandidatesFilter({ env, body }) {
  if (body.job == null) {
    return jsonResponse(400, { error: 'job is required' });
  }
  // Numeric ids skip jobs-table validation; KV first, D1 fallback's own
  // 404 below handles "really unknown job".
  const jobRes = await resolveJob(env, body.job, { validateNumeric: false });
  if (!jobRes.ok) {
    if (jobRes.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(jobRes));
    }
    return jsonResponse(404, { error: 'unknown job' });
  }
  const jobId = jobRes.value.id;
  const limit = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // KV-first read — sync-worker rebuilds these on each tick.
  let snap = null;
  const cached = await env.SYNC_STATE.get(`mcp:job-candidates:${jobId}`);
  if (cached) snap = JSON.parse(cached);

  // Cache miss → live D1 build + write back.
  if (!snap) {
    snap = await buildListFromD1(env, jobId);
    if (!snap) return jsonResponse(404, { error: 'unknown job' });
    await env.SYNC_STATE.put(
      `mcp:job-candidates:${jobId}`,
      JSON.stringify(snap),
      { expirationTtl: 3600 },
    );
  }

  // Apply the optional `stage` filter, then truncate to `limit`.  Truncation
  // reflects the post-filter list, so `truncated` means "more matched the
  // filter than fit in this response".
  // `stage` is fuzzy-resolved against the snapshot's distinct stage_names so
  // recruiter/Claude inputs like "cv sent" / "1st" land on canonical names
  // without a round-trip. Ambiguity returns the standard 200 envelope;
  // not_found falls through to the literal exact-match (returns empty).
  let matched = snap.matched;
  let stageFilter = body.stage;
  if (body.stage) {
    const distinct = Array.from(new Set(matched.map((c) => c.stage_name).filter(Boolean)));
    if (distinct.length > 0) {
      const resolvable = distinct.map((name) => ({ id: name, name }));
      const r = resolveStage(body.stage, resolvable);
      if (!r.ok && r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      if (r.ok) stageFilter = r.value.name;
    }
  }
  if (stageFilter) matched = matched.filter((c) => c.stage_name === stageFilter);
  const truncated = matched.length > limit;
  matched = matched.slice(0, limit);

  // Project requested fields against a sample candidate to resolve aliases
  // and custom-field names.  Same path as candidate-search.
  const requested = body.fields ?? DEFAULT_FIELDS;
  const sample = matched[0] ?? {};
  const { paths, errors, notes } = resolveFields(requested, sample, sample);
  const projected = matched.map((c) => project(c, paths));

  const response = { job: snap.job, total: snap.total, matched: projected };
  if (truncated) response.truncated = true;
  if (errors.length || notes.length) {
    response._meta = {};
    if (errors.length) response._meta.unresolved_fields = errors;
    if (notes.length) response._meta.notes = notes;
  }
  return jsonResponse(200, response);
}
