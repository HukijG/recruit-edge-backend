/**
 * /mcp/candidate-move-stage — move a candidate to a new stage on a job.
 *
 * Resolution flow is **post-narrow tuple enumeration**, not first-ambiguous
 * short-circuit. The handler enumerates every valid (candidate, job, stage)
 * tuple that could be the answer, then:
 *
 *   - 0 tuples → 400 (the body's stage / job / candidate combination is
 *     genuinely unworkable).
 *   - 1 tuple → commit immediately. This is the auto-narrow win: even if
 *     candidate is fuzzy-ambiguous, only one Jerry might be on the requested
 *     job — that single tuple wins.
 *   - >1 tuples → return a lean `needs_disambiguation` envelope. `kind` is
 *     the smallest level of variation across the tuples (candidates differ
 *     → 'candidate'; same candidate but jobs differ → 'job'; same candidate
 *     and job but stages differ → 'stage'). Options carry only the fields
 *     needed to disambiguate at that level.
 *
 * Numeric ids on candidate/job/stage still work — they short-circuit the
 * fuzzy step inside the resolver. The post-narrow happens regardless of
 * numeric vs string input.
 */

import { jsonResponse } from './router.js';
import { getFullCandidateById } from './d1-read.js';
import {
  resolveCandidate,
  resolveJob,
  resolveStage,
} from './resolvers.js';
import {
  getRFCandidate,
  classifyRFResponse,
  RFRateLimitedError,
} from '../rf-client.js';
import { pMapLimit } from './concurrency.js';

const HYDRATION_CONCURRENCY = 8;

/**
 * RF /candidate/move-to-stage with typed-error classification. Delegates to
 * the shared `classifyRFResponse` helper so that 429 (RFRateLimitedError, with
 * RFC-7231-compliant Retry-After parsing including HTTP-date), 5xx
 * (RFTransientError), and other non-2xx (RFError) all surface as the canonical
 * typed errors. The caller maps these to the lean response envelope.
 */
async function callRfMoveStage(env, payload) {
  const r = await fetch(`${env.RF_API_BASE_URL}/candidate/move-to-stage`, {
    method: 'POST',
    headers: { 'RF-Api-Key': env.RF_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw classifyRFResponse(r, text);
  }
  return r.json();
}

/**
 * Map a thrown error from callRfMoveStage into the lean response envelope.
 * Centralised so both the fast-path short-circuit and the tuple-commit
 * branch agree.
 */
function moveStageErrorResponse(err) {
  if (err instanceof RFRateLimitedError) {
    return jsonResponse(200, {
      ok: false, kind: 'rate_limited', recoverable: false,
      retry_after_ms: err.retryAfterMs ?? null,
      error: 'RF rate limited',
    });
  }
  return jsonResponse(200, {
    ok: false, kind: 'rf_unavailable', recoverable: true,
    error: 'RF move-to-stage failed',
  });
}

/**
 * For a single candidate, enumerate every (job, stage) pair compatible with
 * `body.job` and `body.stage`. Caller flattens these into the global tuple
 * pool with the candidate attached.
 */
async function enumerateJobStagePairs(env, candidate, body) {
  const nonDq = (candidate.jobs ?? []).filter((j) => !j.disqualified);
  if (nonDq.length === 0) return [];

  let jobsToConsider;
  if (body.job != null) {
    const jobRes = await resolveJob(env, body.job, { restrictTo: nonDq });
    if (jobRes.ok) {
      jobsToConsider = [jobRes.value];
    } else if (jobRes.reason === 'ambiguous') {
      jobsToConsider = jobRes.options
        .map((o) => nonDq.find((j) => Number(j.job_id) === Number(o.id)))
        .filter(Boolean);
    } else {
      return []; // job not_found on this candidate — skip the candidate.
    }
  } else if (nonDq.length === 1) {
    jobsToConsider = [nonDq[0]];
  } else {
    jobsToConsider = nonDq;
  }

  const pairs = [];
  for (const job of jobsToConsider) {
    const stageRes = resolveStage(body.stage, job.stages ?? []);
    if (stageRes.ok) {
      pairs.push({ job, stage: stageRes.value });
    } else if (stageRes.reason === 'ambiguous') {
      // Each ambiguous stage option becomes its own tuple — post-narrow may
      // collapse if other resolves uniquely identify one tuple.
      for (const stageOpt of stageRes.options) {
        const fullStage = (job.stages ?? []).find((s) => s.id === stageOpt.id);
        if (fullStage) pairs.push({ job, stage: fullStage });
      }
    }
    // not_found → skip this (candidate, job) pair
  }
  return pairs;
}

export async function handleCandidateMoveStage({ env, body, consultant }) {
  const hasCandidate = body.candidate != null || body.candidate_id != null;
  const hasStage = body.stage != null || body.stage_id != null;
  if (!hasCandidate) {
    return jsonResponse(400, { error: 'candidate is required' });
  }
  if (!hasStage) {
    return jsonResponse(400, { error: 'stage is required' });
  }

  // ─── Fast path: all three *_id fields present → skip resolver/post-narrow ───
  // Used on follow-up turns where Claude has the IDs from a prior response.
  // Still validates the candidate-job-stage tuple by live-fetching the full
  // RF body (thin cache only has id+name; jobs[]/stages live only on RF).
  if (body.candidate_id != null && body.job_id != null && body.stage_id != null) {
    let candRes;
    try {
      candRes = await getFullCandidateById(env, Number(body.candidate_id));
    } catch (err) {
      if (err instanceof RFRateLimitedError) {
        return jsonResponse(200, {
          ok: false, kind: 'rate_limited', recoverable: false,
          retry_after_ms: err.retryAfterMs ?? null,
          error: 'RF rate limited',
        });
      }
      return jsonResponse(200, {
        ok: false, kind: 'rf_unavailable', recoverable: true,
        error: err?.message ?? String(err),
      });
    }
    // Lean envelope: HTTP 200 + {ok:false, kind:'no_candidate'} for missing
    // candidate. Consumer apologises + asks for a better-narrowed reference.
    if (!candRes.ok) return jsonResponse(200, { ok: false, kind: 'no_candidate', error: 'candidate not found', candidate_id: body.candidate_id });
    const candidate = candRes.value;
    const link = (candidate.jobs ?? []).find((j) => Number(j.job_id) === Number(body.job_id));
    // Lean envelope: candidate-job linkage missing — recoverable, consumer
    // re-asks the user with a different (candidate, job) pairing.
    if (!link) return jsonResponse(200, { ok: false, kind: 'not_on_job', error: 'candidate is not on that job', candidate_id: body.candidate_id, job_id: body.job_id });
    const stage = (link.stages ?? []).find((s) => Number(s.id) === Number(body.stage_id));
    // Lean envelope: stage missing on this job's pipeline.
    if (!stage) return jsonResponse(200, { ok: false, kind: 'no_stage', error: 'stage not found on this job', stage_id: body.stage_id });

    try {
      await callRfMoveStage(env, {
        id: candidate.id,
        job_id: link.job_id,
        stage: { id: stage.id, name: stage.name },
        user_id: consultant.rfUserId,
      });
    } catch (err) {
      console.error('move-stage RF call failed:', err);
      return moveStageErrorResponse(err);
    }
    return jsonResponse(200, {
      ok: true,
      moved: {
        candidate_id: candidate.id,
        candidate_name: candidate.name,
        job_id: link.job_id,
        job_name: link.job_name,
        from_stage: link.stage_name,
        to_stage: stage.name,
      },
    });
  }

  // ─── Partial *_id inputs → coerce onto fuzzy fields and fall through ───
  // Numeric inputs to resolveCandidate / resolveJob / resolveStage already
  // short-circuit to direct lookups, so this gives deterministic behaviour
  // without duplicating the post-narrow logic.
  if (body.candidate_id != null && body.candidate == null) {
    body = { ...body, candidate: Number(body.candidate_id) };
  }
  if (body.job_id != null && body.job == null) {
    body = { ...body, job: Number(body.job_id) };
  }
  if (body.stage_id != null && body.stage == null) {
    body = { ...body, stage: Number(body.stage_id) };
  }

  // 1. Resolve candidate(s). Single id / unique fuzzy → one option (full
  //    body live-fetched from RF by resolveCandidate). Ambiguous → fan out
  //    to /candidate/get per option for the post-narrow check.
  let candRes;
  try {
    candRes = await resolveCandidate(env, body.candidate);
  } catch (err) {
    if (err instanceof RFRateLimitedError) {
      return jsonResponse(200, {
        ok: false, kind: 'rate_limited', recoverable: false,
        retry_after_ms: err.retryAfterMs ?? null,
        error: 'RF rate limited',
      });
    }
    return jsonResponse(200, {
      ok: false, kind: 'rf_unavailable', recoverable: true,
      error: err?.message ?? String(err),
    });
  }
  let candidateOptions;
  if (candRes.ok) {
    candidateOptions = [candRes.value];
  } else if (candRes.reason === 'ambiguous') {
    const bodies = await pMapLimit(
      candRes.options.map((o) => o.id),
      HYDRATION_CONCURRENCY,
      async (id) => getRFCandidate(id, env),
    );
    candidateOptions = bodies.filter((r) => r.ok).map((r) => r.value);
  } else {
    // Lean envelope: HTTP 200 + {ok:false, kind:'no_candidate'} — consistent
    // with the rest of the system.
    return jsonResponse(200, { ok: false, kind: 'no_candidate', error: 'candidate not found' });
  }

  // 2. Enumerate every (candidate, job, stage) tuple. The flattening lets a
  //    single uniquely-resolving tuple win even when the candidate fuzzy was
  //    ambiguous — the auto-narrow case.
  const tuples = [];
  for (const candidate of candidateOptions) {
    const pairs = await enumerateJobStagePairs(env, candidate, body);
    for (const p of pairs) {
      tuples.push({ candidate, job: p.job, stage: p.stage });
    }
  }

  // 3. Decide.
  if (tuples.length === 0) {
    return jsonResponse(400, {
      error: `no valid candidate/job/stage combination for stage "${body.stage}"`,
    });
  }

  if (tuples.length === 1) {
    const t = tuples[0];
    try {
      await callRfMoveStage(env, {
        id: t.candidate.id,
        job_id: t.job.job_id,
        stage: { id: t.stage.id, name: t.stage.name },
        user_id: consultant.rfUserId,
      });
    } catch (err) {
      console.error('move-stage RF call failed:', err);
      return moveStageErrorResponse(err);
    }
    return jsonResponse(200, {
      ok: true,
      moved: {
        candidate_id: t.candidate.id,
        candidate_name: t.candidate.name,
        job_id: t.job.job_id,
        job_name: t.job.job_name,
        from_stage: t.job.stage_name,
        to_stage: t.stage.name,
      },
    });
  }

  // Multiple tuples → lean enriched disambiguation. Pick the smallest level
  // of variation as the `kind` so the consumer asks the user the smallest
  // possible question.
  const candIds = new Set(tuples.map((t) => t.candidate.id));
  const jobIds = new Set(tuples.map((t) => t.job.job_id));

  let kind;
  if (candIds.size > 1) kind = 'candidate';
  else if (jobIds.size > 1) kind = 'job';
  else kind = 'stage';

  const options = tuples.map((t) => {
    if (kind === 'candidate') {
      // Candidate identity + just-enough tuple context per row so the
      // consumer can render distinct lines without a follow-up call.
      return {
        id: t.candidate.id,
        name: t.candidate.name,
        current_organization: t.candidate.current_organization ?? null,
        current_title: t.candidate.current_title ?? null,
        job_id: t.job.job_id,
        job_name: t.job.job_name,
        to_stage: t.stage.name,
      };
    }
    if (kind === 'job') {
      // Legacy shape preserved (job_id, job_name) for the multi-non-DQ-jobs
      // path; from_stage / to_stage added so the consumer can confirm the
      // intended movement at a glance.
      return {
        job_id: t.job.job_id,
        job_name: t.job.job_name,
        client_company_name: t.job.client_company_name ?? null,
        from_stage: t.job.stage_name,
        to_stage: t.stage.name,
      };
    }
    // kind === 'stage'
    return {
      id: t.stage.id,
      name: t.stage.name,
    };
  });

  return jsonResponse(200, {
    needs_disambiguation: true,
    kind,
    options,
    hint: `Multiple ${kind}s match — please be more specific.`,
  });
}
