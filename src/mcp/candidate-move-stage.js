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
import { getCandidateById } from './d1-read.js';
import {
  resolveCandidate,
  resolveJob,
  resolveStage,
} from './resolvers.js';

async function callRfMoveStage(env, payload) {
  const r = await fetch(`${env.RF_API_BASE_URL}/candidate/move-to-stage`, {
    method: 'POST',
    headers: { 'RF-Api-Key': env.RF_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`RF move-to-stage ${r.status}: ${await r.text()}`);
  return r.json();
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
  if (body.candidate == null) {
    return jsonResponse(400, { error: 'candidate is required' });
  }
  if (body.stage == null) {
    return jsonResponse(400, { error: 'stage is required' });
  }

  // 1. Resolve candidate(s). Single id / unique fuzzy → one option.
  //    Ambiguous → load all top-K bodies for post-narrow consideration.
  const candRes = await resolveCandidate(env, body.candidate);
  let candidateOptions;
  if (candRes.ok) {
    candidateOptions = [candRes.value];
  } else if (candRes.reason === 'ambiguous') {
    const bodies = await Promise.all(
      candRes.options.map((o) => getCandidateById(env, o.id)),
    );
    candidateOptions = bodies.filter(Boolean);
  } else {
    return jsonResponse(404, { error: 'candidate not found' });
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
      return jsonResponse(502, { error: 'RF move-to-stage failed' });
    }
    await Promise.all([
      env.SYNC_STATE.delete(`mcp:pipeline:${t.job.job_id}`),
      env.SYNC_STATE.delete(`mcp:job-candidates:${t.job.job_id}`),
    ]);
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
