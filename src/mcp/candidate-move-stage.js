/**
 * /mcp/candidate-move-stage — move a candidate to a new stage on a job.
 *
 * D1 is read-only here: we look up the candidate snapshot to resolve the job
 * (single non-disqualified job, or by `job` body param) and the stage (by id
 * or name within that job's `stages[]`). The actual write goes to RF, then
 * we invalidate the two job-scoped KV snapshots so the next read repopulates
 * after the next sync tick catches up.
 *
 * Fuzzy candidate resolution is intentionally not wired in yet — callers must
 * pass a numeric candidate id (the MCP-facing tools resolve this upstream via
 * /mcp/candidate-search). Returns `needs_disambiguation` when the candidate
 * has multiple non-DQ jobs and no `job` was specified, mirroring the protocol
 * used by /mcp/candidate-search for ambiguous matches.
 */

import { jsonResponse } from './router.js';
import { getCandidateById } from './d1-read.js';

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
  const candidateId = typeof body.candidate === 'number'
    ? body.candidate
    : (Number.isFinite(Number(body.candidate)) ? Number(body.candidate) : null);
  if (candidateId == null) {
    return jsonResponse(400, {
      error: 'candidate must be numeric id; fuzzy candidate resolution not yet wired into move-stage',
    });
  }

  const candidate = await getCandidateById(env, candidateId);
  if (!candidate) return jsonResponse(404, { error: 'candidate not found' });

  // Resolve target job — only consider non-disqualified job links.
  const nonDq = (candidate.jobs ?? []).filter((j) => !j.disqualified);
  let targetJob;
  if (body.job != null) {
    targetJob = nonDq.find(
      (j) => String(j.job_id) === String(body.job) || j.job_name === body.job,
    );
    if (!targetJob) return jsonResponse(400, { error: 'job not found on this candidate' });
  } else if (nonDq.length === 1) {
    targetJob = nonDq[0];
  } else {
    return jsonResponse(200, {
      needs_disambiguation: true,
      kind: 'job',
      options: nonDq.map((j) => ({
        job_id: j.job_id,
        job_name: j.job_name,
        stage_name: j.stage_name,
      })),
    });
  }

  // Resolve target stage — match by id or by name on the job's stages[].
  const targetStage = targetJob.stages?.find(
    (s) => String(s.id) === String(body.stage) || s.name === body.stage,
  );
  if (!targetStage) {
    return jsonResponse(400, { error: `stage "${body.stage}" not found on job` });
  }

  // RF write — surface upstream failures as 502 to the caller.
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
