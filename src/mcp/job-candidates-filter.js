/**
 * /mcp/job-candidates-filter — flat candidate list for one job, served from
 * `job_pipelines` (the same source as /mcp/job-pipeline; just a different
 * shape on the way out).
 */

import { jsonResponse } from './router.js';
import { session } from './d1-read.js';
import { resolveFieldsWithDefaults } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';
import { resolveJob, resolveStage, disambiguationPayload } from './resolvers.js';

const DEFAULT_FIELDS = ['id', 'name', 'linkedin_profile'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function handleJobCandidatesFilter({ env, body }) {
  // Resolve job.
  let jobMeta;
  if (body.job_id != null) {
    const id = Number(body.job_id);
    if (!Number.isFinite(id)) return jsonResponse(400, { error: 'job_id must be numeric' });
    jobMeta = await session(env).prepare('SELECT id, name FROM jobs WHERE id = ?').bind(id).first();
    if (!jobMeta) return jsonResponse(404, { error: 'unknown job', job_id: id });
  } else if (body.job != null) {
    const r = await resolveJob(env, body.job, { validateNumeric: true });
    if (!r.ok) {
      if (r.reason === 'ambiguous') return jsonResponse(200, disambiguationPayload(r));
      return jsonResponse(404, { error: 'unknown job' });
    }
    jobMeta = { id: r.value.id, name: r.value.name };
  } else {
    return jsonResponse(400, { error: 'job or job_id is required' });
  }

  const limit = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const row = await session(env)
    .prepare('SELECT summary_json, stage_candidates_json FROM job_pipelines WHERE job_id = ?')
    .bind(jobMeta.id)
    .first();
  if (!row) {
    return jsonResponse(200, {
      job: jobMeta,
      total: 0,
      matched: [],
      _meta: { warnings: ['pipeline cache not yet built for this job — try again after the next 15-min sync tick'] },
    });
  }

  const summary = JSON.parse(row.summary_json);
  const byStage = JSON.parse(row.stage_candidates_json);

  // Resolve `stage` (optional fuzzy) → narrow to one stage.
  let stageFilter = null;
  if (body.stage) {
    const exact = summary.find((s) => s.name === body.stage);
    if (exact) stageFilter = exact.name;
    else {
      const r = resolveStage(body.stage, summary.map((s) => ({ id: s.name, name: s.name })));
      if (!r.ok && r.reason === 'ambiguous') return jsonResponse(200, disambiguationPayload(r));
      if (r.ok) stageFilter = r.value.name;
      else stageFilter = body.stage;  // not_found → empty result
    }
  }

  // Collect candidate ids — one stage or all (excluding DQ unless include_disqualified).
  let allIds = [];
  let totalIds = 0;
  for (const s of summary) {
    if (stageFilter && s.name !== stageFilter) continue;
    if (!body.include_disqualified && s.name === 'Disqualified') continue;
    const ids = byStage[s.name] ?? [];
    totalIds += ids.length;
    allIds.push(...ids.map((id) => ({ id, stage: s.name })));
  }

  const truncated = allIds.length > limit;
  const sliced = allIds.slice(0, limit);

  // Hydrate.
  let bodyById = new Map();
  if (sliced.length) {
    const ids = sliced.map((x) => x.id);
    const placeholders = ids.map(() => '?').join(', ');
    const { results } = await session(env)
      .prepare(`SELECT id, body FROM candidates WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all();
    bodyById = new Map((results ?? []).map((r) => [r.id, JSON.parse(r.body || '{}')]));
  }

  const matched = sliced
    .map((x) => bodyById.get(x.id))
    .filter(Boolean)
    .map((c) => {
      const { paths } = resolveFieldsWithDefaults(body.fields, DEFAULT_FIELDS, c, c);
      return projectWithLinkedIn(c, paths);
    });

  const response = { job: jobMeta, total: totalIds, matched };
  if (truncated) response.truncated = true;
  return jsonResponse(200, response);
}
