/**
 * /mcp/job-pipeline — pipeline view for one job, sourced from `job_pipelines`.
 *
 * Reads RF's canonical `summary[]` (verbatim) and per-stage active-candidate
 * IDs from the `job_pipelines` row that the sync-worker rebuilds every 15
 * min. Hydrates candidate detail with one batched SELECT against the
 * `candidates` table.
 *
 * Filtering precedence:
 *   1. `stage`                — single-stage exact match (fuzzy fallback);
 *                               ambiguity → 200 disambiguation.
 *   2. `from` / `to`          — exact match on either bound (fuzzy fallback);
 *                               output range = summary[fromIdx..toIdx].
 *   3. `submitted: true` OR no filters — exact match on "CV Sent" (no fuzzy);
 *                               on miss, return the full pipeline + warning.
 *
 * Disqualified stage excluded from output unless `include_disqualified: true`.
 *
 * Cold cache (no job_pipelines row): 200 with empty payload + warning. The
 * next 15-min tick will populate it. Main worker does not trigger an
 * out-of-band rebuild — that would break the writer-isolation invariant.
 */

import { jsonResponse } from './router.js';
import { session } from './d1-read.js';
import { resolveFieldsWithDefaults } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';
import { resolveJob, resolveStage, disambiguationPayload } from './resolvers.js';

const DEFAULT_FIELDS = ['id', 'name', 'linkedin_profile'];
const SUBMITTED_LANDMARK = 'CV Sent';

async function loadJobMeta(env, jobId) {
  return session(env)
    .prepare('SELECT id, name, client_company_name FROM jobs WHERE id = ?')
    .bind(jobId)
    .first();
}

async function loadPipelineRow(env, jobId) {
  return session(env)
    .prepare('SELECT summary_json, stage_candidates_json FROM job_pipelines WHERE job_id = ?')
    .bind(jobId)
    .first();
}

/**
 * Find a stage's index in summary[] by exact name first, then fuzzy. Returns
 * `{ idx, ambiguous? }` — caller short-circuits on ambiguous.
 */
function locateStageInSummary(stageName, summary) {
  const exact = summary.findIndex((s) => s.name === stageName);
  if (exact >= 0) return { idx: exact };
  const r = resolveStage(stageName, summary.map((s) => ({ id: s.name, name: s.name })));
  if (!r.ok && r.reason === 'ambiguous') return { idx: -1, ambiguous: r };
  if (r.ok) return { idx: summary.findIndex((s) => s.name === r.value.name) };
  return { idx: -1 };
}

/**
 * Pick the stages for the response based on body filters.
 * Returns either { stages, warnings } on success or { ambiguous } when a
 * fuzzy-resolved stage is too ambiguous.
 */
function selectStages(body, summary) {
  const warnings = [];

  // Single-stage filter.
  if (body.stage) {
    const r = locateStageInSummary(body.stage, summary);
    if (r.ambiguous) return { ambiguous: r.ambiguous };
    if (r.idx < 0) return { stages: [], warnings: [`unknown stage "${body.stage}" — empty result`] };
    return { stages: [summary[r.idx]], warnings };
  }

  // Range filter via from/to.
  if (body.from || body.to) {
    let fromIdx = 0;
    let toIdx = summary.length - 1;
    if (body.from) {
      const r = locateStageInSummary(body.from, summary);
      if (r.ambiguous) return { ambiguous: r.ambiguous };
      if (r.idx >= 0) fromIdx = r.idx;
      else warnings.push(`unknown 'from' stage "${body.from}" — defaulting to start of pipeline`);
    }
    if (body.to) {
      const r = locateStageInSummary(body.to, summary);
      if (r.ambiguous) return { ambiguous: r.ambiguous };
      if (r.idx >= 0) toIdx = r.idx;
      else warnings.push(`unknown 'to' stage "${body.to}" — defaulting to end of pipeline`);
    }
    return { stages: summary.slice(fromIdx, toIdx + 1), warnings };
  }

  // Default + submitted: exact "CV Sent" → end of pipeline.
  const cvSentIdx = summary.findIndex((s) => s.name === SUBMITTED_LANDMARK);
  if (cvSentIdx < 0) {
    warnings.push(`job pipeline has no '${SUBMITTED_LANDMARK}' stage — returning full pipeline`);
    return { stages: summary.slice(), warnings };
  }
  return { stages: summary.slice(cvSentIdx), warnings };
}

export async function handleJobPipeline({ env, body }) {
  // Resolve job (id short-circuit if `job_id` present).
  let jobMeta;
  if (body.job_id != null) {
    const id = Number(body.job_id);
    if (!Number.isFinite(id)) return jsonResponse(400, { error: 'job_id must be numeric' });
    jobMeta = await loadJobMeta(env, id);
    if (!jobMeta) return jsonResponse(404, { error: 'unknown job', job_id: id });
  } else if (body.job != null) {
    const r = await resolveJob(env, body.job, { validateNumeric: true });
    if (!r.ok) {
      if (r.reason === 'ambiguous') return jsonResponse(200, disambiguationPayload(r));
      return jsonResponse(404, { error: 'unknown job' });
    }
    jobMeta = { id: r.value.id, name: r.value.name, client_company_name: r.value.client_company_name };
  } else {
    return jsonResponse(400, { error: 'job or job_id is required' });
  }

  // Read pipeline row.
  const row = await loadPipelineRow(env, jobMeta.id);
  if (!row) {
    return jsonResponse(200, {
      job: { id: jobMeta.id, name: jobMeta.name, client_company_name: jobMeta.client_company_name },
      stage_breakdown: [],
      stages: {},
      _meta: { warnings: ['pipeline cache not yet built for this job — try again after the next 15-min sync tick'] },
    });
  }
  const summary = JSON.parse(row.summary_json);
  const byStage = JSON.parse(row.stage_candidates_json);

  // Pick stages.
  const sel = selectStages(body, summary);
  if (sel.ambiguous) return jsonResponse(200, disambiguationPayload(sel.ambiguous));
  let selected = sel.stages;
  const warnings = [...sel.warnings];

  // DQ exclusion (default).
  if (!body.include_disqualified) {
    selected = selected.filter((s) => s.name !== 'Disqualified');
  }

  // Hydrate candidates: collect all ids in selected stages, single SELECT.
  const allIds = selected.flatMap((s) => byStage[s.name] ?? []);
  let bodyById = new Map();
  if (allIds.length) {
    const placeholders = allIds.map(() => '?').join(', ');
    const { results } = await session(env)
      .prepare(`SELECT id, body FROM candidates WHERE id IN (${placeholders})`)
      .bind(...allIds)
      .all();
    bodyById = new Map((results ?? []).map((r) => [r.id, JSON.parse(r.body || '{}')]));
  }

  // Build per-stage projection.
  const stages = {};
  const stage_breakdown = selected.map((s) => {
    const ids = byStage[s.name] ?? [];
    stages[s.name] = ids
      .map((id) => bodyById.get(id))
      .filter(Boolean)
      .map((c) => {
        const { paths } = resolveFieldsWithDefaults(body.fields, DEFAULT_FIELDS, c, c);
        return projectWithLinkedIn(c, paths);
      });
    return { stage_name: s.name, count: ids.length };
  });

  const response = {
    job: { id: jobMeta.id, name: jobMeta.name, client_company_name: jobMeta.client_company_name },
    stage_breakdown,
    stages,
  };
  if (warnings.length) response._meta = { warnings };
  return jsonResponse(200, response);
}
