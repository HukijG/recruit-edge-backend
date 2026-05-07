/**
 * /mcp/candidate-move-stage — move a candidate to a new stage on a job.
 *
 * Resolution flow (sequential, ambiguity short-circuits at the FIRST
 * unresolved step):
 *
 *   1. resolveCandidate(body.candidate)
 *      → number / digit-string → D1 lookup
 *      → name → fuzzy via the in-memory snapshot
 *      → ambiguous → 200 { needs_disambiguation, kind: "candidate", options }
 *      → not_found → 404
 *
 *   2. resolveJob(body.job, { restrictTo: candidate.jobs[non-DQ] })
 *      → unset + single non-DQ job → use that job
 *      → unset + multiple non-DQ jobs → 200 { needs_disambiguation, kind: "job" }
 *      → set → must resolve uniquely against the candidate's own jobs
 *
 *   3. resolveStage(body.stage, targetJob.stages)
 *      → numeric id → exact match against stages[]
 *      → name → fuzzy ("call booked" → "Call Booked", "1st" → "1st Interview")
 *      → ambiguous → 200 { needs_disambiguation, kind: "stage" }
 *
 * Only when all three resolve uniquely do we POST to RF /candidate/move-to-stage
 * and invalidate the affected KV snapshots.
 */

import { jsonResponse } from './router.js';
import {
  resolveCandidate,
  resolveJob,
  resolveStage,
  disambiguationPayload,
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

export async function handleCandidateMoveStage({ env, body, consultant }) {
  if (body.candidate == null) {
    return jsonResponse(400, { error: 'candidate is required' });
  }
  if (body.stage == null) {
    return jsonResponse(400, { error: 'stage is required' });
  }

  // 1. Candidate.
  const candRes = await resolveCandidate(env, body.candidate);
  if (!candRes.ok) {
    if (candRes.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(candRes));
    }
    return jsonResponse(404, { error: 'candidate not found' });
  }
  const candidate = candRes.value;

  // 2. Job — restrict resolution to the candidate's own non-DQ jobs.
  const nonDq = (candidate.jobs ?? []).filter((j) => !j.disqualified);
  if (nonDq.length === 0) {
    return jsonResponse(400, { error: 'candidate has no non-disqualified jobs' });
  }
  let targetJob;
  if (body.job != null) {
    const jobRes = await resolveJob(env, body.job, { restrictTo: nonDq });
    if (!jobRes.ok) {
      if (jobRes.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(jobRes));
      }
      return jsonResponse(400, { error: 'job not found on this candidate' });
    }
    targetJob = jobRes.value;
  } else if (nonDq.length === 1) {
    targetJob = nonDq[0];
  } else {
    // Preserve the legacy disambiguation shape used by this endpoint —
    // {kind:'job', options:[{job_id, job_name, stage_name}]} — so existing
    // callers don't break.
    return jsonResponse(200, {
      needs_disambiguation: true,
      kind: 'job',
      options: nonDq.map((j) => ({
        job_id: j.job_id,
        job_name: j.job_name,
        stage_name: j.stage_name,
      })),
      hint: 'Candidate is on multiple jobs — please specify which.',
    });
  }

  // 3. Stage — fuzzy match against the target job's stages[].
  const stageRes = resolveStage(body.stage, targetJob.stages ?? []);
  if (!stageRes.ok) {
    if (stageRes.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(stageRes));
    }
    return jsonResponse(400, { error: `stage "${body.stage}" not found on job` });
  }
  const targetStage = stageRes.value;

  // RF write — surface upstream failures as 502.
  try {
    await callRfMoveStage(env, {
      id: candidate.id,
      job_id: targetJob.job_id,
      stage: { id: targetStage.id, name: targetStage.name },
      user_id: consultant.rfUserId,
    });
  } catch (err) {
    console.error('move-stage RF call failed:', err);
    return jsonResponse(502, { error: 'RF move-to-stage failed' });
  }

  // Invalidate KV snapshots for the affected job. Next read falls back to D1
  // and writes a fresh snapshot — tail sync (15-min cycle) will refresh both
  // the candidate body and the snapshot once RF reports the new stage.
  await Promise.all([
    env.SYNC_STATE.delete(`mcp:pipeline:${targetJob.job_id}`),
    env.SYNC_STATE.delete(`mcp:job-candidates:${targetJob.job_id}`),
  ]);

  return jsonResponse(200, {
    ok: true,
    moved: {
      candidate_id: candidate.id,
      candidate_name: candidate.name,
      job_id: targetJob.job_id,
      job_name: targetJob.job_name,
      from_stage: targetJob.stage_name,
      to_stage: targetStage.name,
    },
  });
}
