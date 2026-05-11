/**
 * /mcp/job-pipeline — pipeline view for one job, served via live RF
 * `/job/pipeline?job_id=…` + conditional per-candidate hydration.
 *
 * Per spec rev 5 (thin-immutable cache design),
 * the legacy `job_pipelines` D1 cache is gone. Each read is:
 *
 *   1. ONE live RF `/job/pipeline?job_id=<id>` call (~300–800 ms baseline).
 *      Returns `{summary: [{id, name, count}], detail: [{candidate: {id,
 *      name}, stages: [{from, time, to}]}]}`. `summary[]` is the canonical
 *      ordered pipeline (per-job, includes 0-count stages and `Disqualified`);
 *      `detail[]` is each candidate's full stage-movement history — the most
 *      recent `stages[].time` `to` is their current stage.
 *
 *   2. Apply Claude's `body.{stage|from|to|submitted}` window to the
 *      derived per-stage active-candidate-id map. Same windowing semantics
 *      as the legacy handler:
 *        • `stage`         → single-stage exact match (fuzzy fallback;
 *                            ambiguity → 200 disambiguation envelope)
 *        • `from` / `to`   → range on summary[] (fuzzy fallback)
 *        • `submitted: true` OR no filters → exact "CV Sent" → end of
 *                            pipeline; on miss return full pipeline + warning
 *      Disqualified excluded unless `include_disqualified: true`.
 *
 *   3. Conditional per-candidate hydration based on Claude's `fields[]`:
 *        • Thin-only (default `['id', 'name', 'linkedin_profile']`, or any
 *          subset of cached columns) → ONE D1 batch via `getCandidatesByIds`
 *          (~5–10 ms).
 *        • Expanded (any field requiring live data — `current_title`,
 *          `primary_email`, `phone_numbers`, custom fields, etc.) → parallel
 *          `/candidate/get` fan-out at concurrency 8 via `pMapLimit`. Per-id
 *          failures surface as `hydration_errors[]` in the response —
 *          partial results returned, never a thrown error.
 *
 * Why no KV warm layer between RF and the response: a pipeline cache would
 * have to be invalidated on every move-stage / disqualification / owner
 * reassignment / new-candidate-on-job — bust paths multiply faster than the
 * read savings. RF's composition is the source of truth; this tool is a
 * pass-through with conditional hydration aligned to Claude's opt-in.
 *
 * Latency profile (per spec rev 5, lines 262–264):
 *   • Thin (default) fields: ~300–810 ms (RF pipeline call + D1 hydration).
 *   • Expanded fields, N candidates in selected stages: ~300–800 ms +
 *     ceil(N/8) × ~150 ms.
 */

import { jsonResponse } from './router.js';
import { resolveFieldsWithDefaults } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';
import { resolveJob, resolveStage, disambiguationPayload } from './resolvers.js';
import { session, getCandidatesByIds } from './d1-read.js';
import { fetchRFJobPipeline, getRFCandidate } from '../rf-client.js';
import { pMapLimit } from './concurrency.js';

const DEFAULT_FIELDS = ['id', 'name', 'linkedin_profile'];
const SUBMITTED_LANDMARK = 'CV Sent';
const HYDRATION_CONCURRENCY = 8;

/**
 * Field names served entirely by the thin candidates_v2 D1 row. Anything
 * outside this set forces the expanded-hydration fan-out.
 *
 * Keep in sync with `candidates_v2` columns in
 * `sync-worker/migrations/0003_v2_tables.sql`.
 */
const THIN_FIELDS = new Set([
  'id',
  'name',
  'linkedin_profile',
  'added_time_ms',
]);

function isThinOnly(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return true;
  return fields.every((f) => THIN_FIELDS.has(f));
}

/**
 * RF `/job/pipeline` `detail[]` → `{stageName: candidateId[]}` map.
 *
 * Mirrors the proven sync-worker normalisation (`sync-worker/src/pipeline-normalize.js`)
 * but keeps Disqualified candidates in a separate bucket so the read-time
 * `include_disqualified` flag can opt them in without re-fetching. The
 * "current stage" is the `to` field of the entry with the latest `time`.
 *
 * Returns `{active: {stageName: id[]}, disqualified: id[]}`.
 */
function indexPipelineDetail(detail) {
  const active = {};
  const disqualified = [];
  if (!Array.isArray(detail)) return { active, disqualified };
  for (const entry of detail) {
    const id = entry?.candidate?.id;
    if (id == null) continue;
    const stages = Array.isArray(entry.stages) ? entry.stages : [];
    if (stages.length === 0) continue;
    let latest = stages[0];
    for (let i = 1; i < stages.length; i++) {
      if (Date.parse(stages[i].time) > Date.parse(latest.time)) latest = stages[i];
    }
    const current = latest?.to;
    if (!current) continue;
    if (current === 'Disqualified') {
      disqualified.push(id);
    } else {
      (active[current] ??= []).push(id);
    }
  }
  return { active, disqualified };
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
 * Returns either `{ stages, warnings }` on success or `{ ambiguous }` when a
 * fuzzy-resolved stage is too ambiguous.
 *
 * `stages` is the windowed slice of `summary[]` — preserves canonical pipeline
 * order. Caller applies DQ exclusion.
 */
function selectStages(body, summary) {
  const warnings = [];

  // Single-stage filter.
  if (body.stage) {
    const r = locateStageInSummary(body.stage, summary);
    if (r.ambiguous) return { ambiguous: r.ambiguous };
    if (r.idx < 0) {
      return { stages: [], warnings: [`unknown stage "${body.stage}" — empty result`] };
    }
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

/**
 * Look up `{id, name, client_company_name}` for a numeric job id from the
 * `jobs` cache table. Used by the `body.job_id` short-circuit and after a
 * numeric `body.job` resolves via `resolveJob` so the response carries the
 * job's display name.
 *
 * NB: this still reads the legacy `jobs` table during the dual-write window;
 * Task 27 of the rev-5 plan migrates to `jobs_v2`. Returns null on miss.
 */
async function loadJobMeta(env, jobId) {
  return session(env)
    .prepare('SELECT id, name, client_company_name FROM jobs WHERE id = ?')
    .bind(jobId)
    .first();
}

/**
 * Resolve the job reference. Returns `{ ok: true, jobMeta }` or
 * `{ response }` (an already-formed disambiguation / 4xx Response).
 *
 * Mirrors the legacy job-pipeline resolver semantics: `job_id` is a numeric
 * short-circuit that requires a `jobs`-cache row (404 on miss); `job` is
 * fuzzy via `resolveJob` (200 disambiguation envelope on ambiguity, 404 on
 * miss). Both paths populate `name` + `client_company_name` so the response
 * envelope stays consistent with the legacy contract.
 */
async function resolveJobOrRespond(env, body) {
  if (body.job_id != null) {
    const id = Number(body.job_id);
    if (!Number.isFinite(id)) {
      return { response: jsonResponse(400, { error: 'job_id must be numeric' }) };
    }
    const meta = await loadJobMeta(env, id);
    if (!meta) return { response: jsonResponse(404, { error: 'unknown job', job_id: id }) };
    return { ok: true, jobMeta: meta };
  }
  if (body.job != null) {
    const r = await resolveJob(env, body.job, { validateNumeric: true });
    if (!r.ok) {
      if (r.reason === 'ambiguous') {
        return { response: jsonResponse(200, disambiguationPayload(r)) };
      }
      return { response: jsonResponse(404, { error: 'unknown job' }) };
    }
    return {
      ok: true,
      jobMeta: {
        id: r.value.id,
        name: r.value.name ?? null,
        client_company_name: r.value.client_company_name ?? null,
      },
    };
  }
  return { response: jsonResponse(400, { error: 'job or job_id is required' }) };
}

export async function handleJobPipeline({ env, body }) {
  // ── 1. Resolve job (numeric short-circuit OR fuzzy via resolver). ────
  const jobRes = await resolveJobOrRespond(env, body);
  if (!jobRes.ok) return jobRes.response;
  const { jobMeta } = jobRes;

  // ── 2. Live RF pipeline fetch. ───────────────────────────────────────
  let pipeline;
  try {
    pipeline = await fetchRFJobPipeline(env, jobMeta.id);
  } catch (err) {
    return jsonResponse(200, {
      ok: false,
      recoverable: true,
      kind: 'pipeline_unavailable',
      job: jobMeta,
      error: err.message,
    });
  }

  const summary = Array.isArray(pipeline?.summary) ? pipeline.summary : [];
  const { active, disqualified } = indexPipelineDetail(pipeline?.detail);

  // ── 3. Apply windowing (stage / from-to / submitted / default). ──────
  const sel = selectStages(body, summary);
  if (sel.ambiguous) return jsonResponse(200, disambiguationPayload(sel.ambiguous));
  let selectedSummary = sel.stages;
  const warnings = [...sel.warnings];

  // DQ exclusion (default).
  if (!body.include_disqualified) {
    selectedSummary = selectedSummary.filter((s) => s.name !== 'Disqualified');
  }

  // ── 4. Build the per-stage active-candidate-id list (windowed). ──────
  const stageIds = new Map();
  for (const s of selectedSummary) {
    if (s.name === 'Disqualified') {
      stageIds.set(s.name, disqualified.slice());
    } else {
      stageIds.set(s.name, (active[s.name] ?? []).slice());
    }
  }
  const allIds = [...new Set([...stageIds.values()].flat())];

  const fields = body.fields;
  const useThinPath = isThinOnly(fields);

  // ── 5. Hydrate per requested fields. ─────────────────────────────────
  let bodyById;
  let hydration_errors = [];

  if (useThinPath) {
    // Thin path: one D1 batch over candidates_v2.
    const rows = allIds.length ? await getCandidatesByIds(env, allIds) : [];
    bodyById = new Map(rows.map((r) => [r.id, r]));
  } else {
    // Expanded path: parallel /candidate/get fan-out at concurrency 8.
    bodyById = new Map();
    if (allIds.length) {
      const results = await pMapLimit(allIds, HYDRATION_CONCURRENCY, async (id) =>
        getRFCandidate(id, env),
      );
      for (let i = 0; i < allIds.length; i++) {
        const id = allIds[i];
        const r = results[i];
        if (r.ok) {
          bodyById.set(id, r.value);
        } else {
          hydration_errors.push({ id, reason: r.error?.message ?? String(r.error) });
        }
      }
    }
  }

  // ── 6. Project per Claude's fields[] (additive over defaults). ───────
  // Per stage: pick hydrated rows, drop missing, project with LinkedIn URL
  // normalisation. `count` reflects the windowed (post-DQ) candidate count
  // — matches the legacy handler's count semantics.
  const stages = {};
  const stage_breakdown = selectedSummary.map((s) => {
    const ids = stageIds.get(s.name) ?? [];
    stages[s.name] = ids
      .map((id) => bodyById.get(id))
      .filter(Boolean)
      .map((c) => {
        const { paths } = resolveFieldsWithDefaults(fields, DEFAULT_FIELDS, c, c);
        return projectWithLinkedIn(c, paths);
      });
    return { stage_name: s.name, count: ids.length };
  });

  const response = {
    ok: true,
    job: jobMeta,
    stage_breakdown,
    stages,
  };
  if (warnings.length) response._meta = { warnings };
  if (hydration_errors.length) response.hydration_errors = hydration_errors;
  return jsonResponse(200, response);
}
