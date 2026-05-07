/**
 * /mcp/job-pipeline — pre-shaped pipeline view for one job, KV-first.
 *
 * The sync-worker rebuilds `mcp:pipeline:{jobId}` snapshots in KV every tick
 * (see sync-worker/src/snapshots.js).  This handler reads that snapshot
 * directly when present and falls back to a live D1 build on cache miss
 * (writing the result back to KV with a 1h TTL — the next scheduled rebuild
 * will overwrite well before that fires).
 *
 * Filtering options (mutually applied):
 *   - `stage`         — narrow to a single stage by name (fuzzy-resolved
 *                       against the snapshot's populated stage names;
 *                       ambiguous → 200 envelope, not_found → falls through
 *                       to literal exact-match → empty stages)
 *   - `from` / `to`   — fuzzy-resolved against THIS JOB'S pipeline (the
 *                       `pipeline_stages` array carried on the snapshot,
 *                       which is whatever stages RF defined for that job).
 *                       `from: "Replied"` means "Replied → end of pipeline",
 *                       `to: "1st"` means "start → 1st Interview". Combined:
 *                       custom range. Ambiguous → 200 envelope.
 *   - `submitted`     — explicit shortcut: "CV Sent → end" on this job's
 *                       pipeline (whatever the last stage actually is).
 *
 * Default (none of the above set): CV Sent → Offer on this job's pipeline,
 * if both names resolve. Falls back to "show everything" if either doesn't
 * — a job with a non-standard pipeline isn't going to be silently filtered.
 * Recruiters glancing at a job typically want the actively-progressing
 * window; Sourced / Replied are usually noise. To see them anyway, pass
 * `from: "Sourced"` (or any earlier stage), or `stage: "Sourced"` for that
 * single stage.
 *
 * Per-job pipelines: there is NO global canonical stage list. Each job in
 * RF can define its own pipeline (custom stages, screening loops, etc.).
 * The `pipeline_stages` array on the snapshot is the source of truth — both
 * range filters and `submitted` resolve their landmark stages ("CV Sent",
 * "Offer", "Hired") against it via the same fuzzy resolver Claude uses.
 *
 * Field projection follows the same alias-driven path as /mcp/candidate-search;
 * unresolved fields surface in `_meta.unresolved_fields`.
 */

import { jsonResponse } from './router.js';
import { session } from './d1-read.js';
import { resolveFields, project } from './projection.js';
import { resolveJob, resolveStage, disambiguationPayload } from './resolvers.js';

const DEFAULT_FIELDS = ['id', 'name', 'stage_moved'];

// Landmark stage names used by the range-filter defaults / submitted shortcut.
// These are matched fuzzily against THIS JOB'S pipeline_stages — they're the
// names recruiters use, not a hardcoded global list. If a job's pipeline
// doesn't include a "CV Sent" stage at all, the default range falls back to
// the whole pipeline (rather than silently filtering to nothing).
const LANDMARK_DEFAULT_FROM = 'CV Sent';
const LANDMARK_DEFAULT_TO = 'Offer';
const LANDMARK_SUBMITTED_FROM = 'CV Sent';

/**
 * Resolve a stage name to its index in this job's pipeline. Wraps the
 * standard resolveStage so ambiguity surfaces as `{ ambiguous }` for the
 * caller to short-circuit; not_found surfaces as `{ idx: -1 }` so callers
 * can decide whether to fall back (defaults) or treat it as an error
 * (explicit `from`/`to` from the user — we'd rather just leave the bound
 * open than fail the call).
 */
function resolveStageIdx(input, pipelineStages) {
  const list = pipelineStages.map((s, id) => ({ id, name: s.name }));
  const r = resolveStage(input, list);
  if (!r.ok && r.reason === 'ambiguous') return { ambiguous: r };
  if (r.ok) return { idx: r.value.id };
  return { idx: -1 };
}

/**
 * Build the [fromIdx, toIdx] index pair into the job's pipeline_stages.
 * Returns `{ ok: true, range }` on success, `{ ok: false, ambiguous }`
 * when from/to fuzzy-resolves ambiguously (caller emits the standard
 * envelope).
 */
function resolveStageRange(body, pipelineStages) {
  const lastIdx = pipelineStages.length - 1;

  if (body.submitted) {
    const r = resolveStageIdx(LANDMARK_SUBMITTED_FROM, pipelineStages);
    if (r.ambiguous) return { ok: false, ambiguous: r.ambiguous };
    return { ok: true, range: [r.idx >= 0 ? r.idx : 0, lastIdx] };
  }

  let fromIdx;
  let toIdx;
  if (body.from || body.to) {
    fromIdx = 0;
    toIdx = lastIdx;
    if (body.from) {
      const r = resolveStageIdx(body.from, pipelineStages);
      if (r.ambiguous) return { ok: false, ambiguous: r.ambiguous };
      if (r.idx >= 0) fromIdx = r.idx;
    }
    if (body.to) {
      const r = resolveStageIdx(body.to, pipelineStages);
      if (r.ambiguous) return { ok: false, ambiguous: r.ambiguous };
      if (r.idx >= 0) toIdx = r.idx;
    }
  } else {
    // Default: CV Sent → Offer, fuzzily against this job's pipeline.
    // If a landmark isn't present in the pipeline (custom stage names),
    // fall back to the open end — better to over-include than silently
    // hide a job's actual stages.
    const fromR = resolveStageIdx(LANDMARK_DEFAULT_FROM, pipelineStages);
    if (fromR.ambiguous) return { ok: false, ambiguous: fromR.ambiguous };
    const toR = resolveStageIdx(LANDMARK_DEFAULT_TO, pipelineStages);
    if (toR.ambiguous) return { ok: false, ambiguous: toR.ambiguous };
    fromIdx = fromR.idx >= 0 ? fromR.idx : 0;
    toIdx = toR.idx >= 0 ? toR.idx : lastIdx;
  }
  return { ok: true, range: [fromIdx, toIdx] };
}

/**
 * Live-build the pipeline snapshot from D1 when KV misses.  Mirrors the shape
 * sync-worker writes to `mcp:pipeline:{jobId}` — including the per-job
 * `pipeline_stages` array, extracted from any candidate's `body.jobs[k].stages`.
 * Returns null if the job_id is unknown so the caller can return 404.
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

  let pipelineStages = [];
  const stages = new Map();
  for (const r of results ?? []) {
    if (!stages.has(r.stage_name)) stages.set(r.stage_name, []);
    const body = JSON.parse(r.body || '{}');
    if (pipelineStages.length === 0) {
      const link = (body.jobs ?? []).find((j) => Number(j.job_id) === Number(jobId));
      if (Array.isArray(link?.stages) && link.stages.length > 0) {
        pipelineStages = link.stages.map((s) => ({ id: s.id, name: s.name }));
      }
    }
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
    pipeline_stages: pipelineStages,
    stages: [...stages.entries()].map(([stage_name, candidates]) => ({
      stage_name,
      count: candidates.length,
      candidates,
    })),
  };
}

export async function handleJobPipeline({ env, body }) {
  if (body.job == null) {
    return jsonResponse(400, { error: 'job is required' });
  }
  // Resolve `job` — number, digit-string, or fuzzy name. Numeric inputs
  // skip the jobs-table validation: the KV snapshot may exist before the
  // sync-worker has rebuilt the jobs row, and the D1 fallback below
  // returns its own 404 when both KV and the jobs row are missing.
  const jobRes = await resolveJob(env, body.job, { validateNumeric: false });
  if (!jobRes.ok) {
    if (jobRes.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(jobRes));
    }
    return jsonResponse(404, { error: 'unknown job' });
  }
  const jobId = jobRes.value.id;

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

  // Filter pipeline.  Precedence:
  //   1. `stage` (single-stage filter; fuzzy-resolved against the snapshot)
  //   2. `from` / `to` / `submitted` (range filters; fuzzy-resolved against
  //      the canonical PIPELINE_ORDER)
  //   3. Default: CV Sent → Offer.
  //
  // `stage` and the range filters are mutually exclusive in spirit. When
  // both are passed, `stage` wins (it's more specific) and the range
  // filters are ignored — this matches the legacy behaviour for `submitted`.
  let stages = snap.stages;
  let stageFilter = body.stage;
  if (body.stage && stages.length > 0) {
    const resolvable = stages.map((s) => ({ id: s.stage_name, name: s.stage_name }));
    const r = resolveStage(body.stage, resolvable);
    if (!r.ok && r.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(r));
    }
    if (r.ok) stageFilter = r.value.name;
    // not_found falls through to the literal exact-match below — keeps the
    // pre-resolver behaviour for genuinely unknown stages (returns empty).
  }
  if (stageFilter) {
    stages = stages.filter((s) => s.stage_name === stageFilter);
  } else {
    // Range filter — resolved against THIS JOB'S pipeline (carried on the
    // snapshot as `pipeline_stages`). When the snapshot pre-dates the
    // pipeline_stages addition (legacy KV write still in flight), skip the
    // range filter and return everything; the next sync tick will populate
    // it and the default kicks in then.
    const pipelineStages = Array.isArray(snap.pipeline_stages) ? snap.pipeline_stages : [];
    if (pipelineStages.length > 0) {
      const rangeRes = resolveStageRange(body, pipelineStages);
      if (!rangeRes.ok) {
        return jsonResponse(200, disambiguationPayload(rangeRes.ambiguous));
      }
      const [fromIdx, toIdx] = rangeRes.range;
      const allowed = new Set(
        pipelineStages.slice(fromIdx, toIdx + 1).map((s) => s.name),
      );
      stages = stages.filter((s) => allowed.has(s.stage_name));
    }
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
