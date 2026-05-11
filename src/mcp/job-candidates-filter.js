/**
 * /mcp/job-candidates-filter — flat (non-grouped) candidate list for one job,
 * served via live RF `/job/pipeline?job_id=…` + conditional per-candidate
 * hydration.
 *
 * Per spec rev 5 (thin-immutable cache design),
 * the legacy `job_pipelines` D1 cache is gone. Each read is:
 *
 *   1. ONE live RF `/job/pipeline?job_id=<id>` call (~300–800 ms baseline).
 *      Same data source as `/mcp/job-pipeline`; this tool projects a FLAT list
 *      rather than a stage-grouped pipeline view.
 *
 *   2. Apply Claude's filter shape (stage / include_disqualified) to the
 *      derived per-stage candidate-id map. Candidates from all selected stages
 *      are merged into a single ordered list preserving canonical pipeline order
 *      (stage order as returned by RF's `summary[]`).
 *
 *   3. Apply `limit` (default 100, max 500) — truncation sets `truncated: true`
 *      in the response. `total` reflects the pre-truncation matched count.
 *
 *   4. Conditional per-candidate hydration based on Claude's `fields[]`:
 *        • Thin-only (default `['id', 'name', 'linkedin_profile']`, or any
 *          subset of THIN_FIELDS columns) → ONE D1 batch via `getCandidatesByIds`
 *          (~5–10 ms).
 *        • Expanded (any field requiring live data — `current_title`,
 *          `primary_email`, `phone_numbers`, custom fields, etc.) → parallel
 *          `/candidate/get` fan-out at concurrency 8 via `pMapLimit`. Per-id
 *          failures surface as `hydration_errors[]` in the response —
 *          partial results returned, never a thrown error.
 *
 * Response shape:
 *   { ok: true, job, total, matched: [{id, name, linkedin_profile, ...}],
 *     truncated?, hydration_errors?, _meta? }
 *
 * On RF failure:
 *   { ok: false, kind: 'pipeline_unavailable', recoverable: true, job, error }
 *
 * Analytics / filter use cases (spec: flat non-grouped list):
 *   - All candidates in a given stage (body.stage exact/fuzzy)
 *   - All candidates across stages (no body.stage, default includes DQ exclusion)
 *   - Custom field projections (expanded hydration path)
 *   - Date range / added-time filtering (caller provides fields:['added_time_ms'] +
 *     post-filters in tool description — the server returns the field so the
 *     caller can do client-side windowing)
 */

import { jsonResponse } from './router.js';
import { resolveFieldsWithDefaults, resolveFieldName } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';
import { resolveJob, resolveStage, disambiguationPayload } from './resolvers.js';
import { session, getCandidatesByIds } from './d1-read.js';
import {
  fetchRFJobPipeline,
  getRFCandidate,
  RFRateLimitedError,
} from '../rf-client.js';
import { pMapLimit } from './concurrency.js';
import { indexPipelineDetail } from './pipeline-index.js';

const DEFAULT_FIELDS = ['id', 'name', 'linkedin_profile'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const HYDRATION_CONCURRENCY = 8;

/**
 * Field names served entirely by the thin candidates_v2 D1 row. Anything
 * outside this set forces the expanded-hydration fan-out.
 *
 * Resolved via the projection layer's alias map so user-typed aliases
 * (`title` → `current_title`) collapse to the canonical thin column.
 * `current_title` / `current_organization` map to the snapshot columns
 * (at-cache-time; never live) — trade-off documented on the
 * `rf_job_candidates_filter` descriptor.
 *
 * Keep in sync with `candidates_v2` columns in
 * `sync-worker/migrations/0003_v2_tables.sql`.
 */
const THIN_FIELDS = new Set([
  'id',
  'name',
  'linkedin_profile',
  'added_time_ms',
  'current_title_at_cache_time',
  'current_company_at_cache_time',
  'current_title',
  'current_organization',
]);

function canonicalFieldKey(field) {
  if (typeof field !== 'string' || !field) return field;
  const r = resolveFieldName(field, [...THIN_FIELDS]);
  return r?.path ?? field;
}

function isThinOnly(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return true;
  return fields.every((f) => THIN_FIELDS.has(canonicalFieldKey(f)));
}

/**
 * Project a thin candidates_v2 row into a candidate-shaped body so the
 * shared projection / LinkedIn URL normalisation works the same way it does
 * for full RF bodies. Aliases the snapshot columns to user-facing names.
 */
function thinRowToBody(row) {
  return {
    id: row.id,
    name: row.name,
    linkedin_profile: row.linkedin_profile,
    added_time_ms: row.added_time_ms,
    current_title: row.current_title_at_cache_time ?? null,
    current_organization: row.current_company_at_cache_time ?? null,
  };
}

/**
 * Look up `{id, name, client_company_name}` for a numeric job id from the
 * thin `jobs_v2` cache. Returns null on miss.
 */
async function loadJobMeta(env, jobId) {
  return session(env)
    .prepare('SELECT id, name, client_company_name FROM jobs_v2 WHERE id = ?')
    .bind(jobId)
    .first();
}

/**
 * Resolve the job reference. Returns `{ ok: true, jobMeta }` or
 * `{ response }` (an already-formed disambiguation / 4xx Response).
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

/**
 * Resolve an optional `body.stage` filter against the job's `summary[]`.
 * Returns `{ stageFilter: string | null, ambiguous?, warnings }`.
 *
 * `stageFilter === null` means no stage restriction (all stages).
 * `stageFilter` is a string that may not exist in `active` — caller treats
 * that as an empty result for the stage.
 */
function resolveStageFilter(body, summary) {
  const warnings = [];
  if (!body.stage) return { stageFilter: null, warnings };

  const exact = summary.find((s) => s.name === body.stage);
  if (exact) return { stageFilter: exact.name, warnings };

  const r = resolveStage(body.stage, summary.map((s) => ({ id: s.name, name: s.name })));
  if (!r.ok && r.reason === 'ambiguous') return { ambiguous: r, stageFilter: null, warnings };
  if (r.ok) return { stageFilter: r.value.name, warnings };

  // not_found — keep as-is so the collect phase below produces an empty result.
  return { stageFilter: body.stage, warnings: [`unknown stage "${body.stage}" — empty result`] };
}

export async function handleJobCandidatesFilter({ env, body }) {
  // ── 1. Resolve job (numeric short-circuit OR fuzzy via resolver). ────
  const jobRes = await resolveJobOrRespond(env, body);
  if (!jobRes.ok) return jobRes.response;
  const { jobMeta } = jobRes;

  // ── 2. Live RF pipeline fetch. ───────────────────────────────────────
  let pipeline;
  try {
    pipeline = await fetchRFJobPipeline(env, jobMeta.id);
  } catch (err) {
    if (err instanceof RFRateLimitedError) {
      return jsonResponse(200, {
        ok: false,
        recoverable: false,
        kind: 'rate_limited',
        job: jobMeta,
        retry_after_ms: err.retryAfterMs ?? null,
        error: err.message,
      });
    }
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

  // ── 3. Resolve optional stage filter. ────────────────────────────────
  const { stageFilter, ambiguous, warnings: filterWarnings } = resolveStageFilter(body, summary);
  if (ambiguous) return jsonResponse(200, disambiguationPayload(ambiguous));

  // ── 4. Collect candidate ids (flat, preserving canonical stage order). ─
  // Iterate summary[] (canonical pipeline order) so the merged flat list
  // respects stage ordering within the pipeline.
  const limit = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const warnings = [...filterWarnings];

  const allIdEntries = []; // [{id, stage}]
  let totalIds = 0;

  for (const s of summary) {
    if (stageFilter && s.name !== stageFilter) continue;
    if (!body.include_disqualified && s.name === 'Disqualified') continue;

    const ids =
      (s.name === 'Disqualified' ? disqualified : (active[s.name] ?? [])).slice();
    totalIds += ids.length;
    for (const id of ids) {
      allIdEntries.push({ id, stage: s.name });
    }
  }

  const truncated = allIdEntries.length > limit;
  const sliced = allIdEntries.slice(0, limit);

  const fields = body.fields;
  const useThinPath = isThinOnly(fields);

  // ── 5. Hydrate per requested fields. ─────────────────────────────────
  let bodyById;
  let hydration_errors = [];

  if (useThinPath) {
    // Thin path: one D1 batch over candidates_v2; project rows into
    // candidate-shape so current_title / current_organization aliases work.
    const ids = sliced.map((x) => x.id);
    const rows = ids.length ? await getCandidatesByIds(env, ids) : [];
    bodyById = new Map(rows.map((r) => [r.id, thinRowToBody(r)]));
  } else {
    // Expanded path: parallel /candidate/get fan-out at concurrency 8.
    // Per-id failures carry the underlying typed error's status when
    // available (lets observability filter on 429 vs 5xx vs other).
    bodyById = new Map();
    const ids = sliced.map((x) => x.id);
    if (ids.length) {
      const results = await pMapLimit(ids, HYDRATION_CONCURRENCY, async (id) =>
        getRFCandidate(id, env),
      );
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const r = results[i];
        if (r.ok) {
          bodyById.set(id, r.value);
        } else {
          const e = r.error;
          const entry = { id, reason: e?.message ?? String(e) };
          if (typeof e?.status === 'number') entry.status = e.status;
          hydration_errors.push(entry);
        }
      }
    }
  }

  // ── 6. Project per Claude's fields[] (additive over defaults). ───────
  const matched = sliced
    .map((x) => bodyById.get(x.id))
    .filter(Boolean)
    .map((c) => {
      const { paths } = resolveFieldsWithDefaults(fields, DEFAULT_FIELDS, c, c);
      return projectWithLinkedIn(c, paths);
    });

  const response = { ok: true, job: jobMeta, total: totalIds, matched };
  if (truncated) response.truncated = true;
  if (warnings.length) response._meta = { warnings };
  if (hydration_errors.length) response.hydration_errors = hydration_errors;
  return jsonResponse(200, response);
}
