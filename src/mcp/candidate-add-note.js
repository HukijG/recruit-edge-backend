/**
 * /mcp/candidate-add-note — write a note to a candidate's RF timeline.
 *
 * Mirrors the post-narrow shape of /mcp/candidate-log-interview: enumerate
 * candidate options, optionally filter by job, auto-commit on the unique
 * survivor, otherwise emit a lean disambiguation envelope. Markdown bodies
 * render to HTML server-side via `mdToHtml`. Attribution is always the
 * JWT-resolved consultant — no override surface.
 *
 * Exports:
 *   - handleCandidateAddNote — HTTP handler.
 *   - addNoteForCandidate    — internal callable for in-process reuse by
 *                              future tools (e.g. the Dialpad-call-to-note
 *                              tool) that already hold a resolved candidate
 *                              and consultant record.
 */

import { jsonResponse } from './router.js';
import { getCandidateById } from './d1-read.js';
import { resolveCandidate, resolveJob } from './resolvers.js';
import { mdToHtml } from './markdown.js';
import { addRFCandidateNote } from '../rf-client.js';

/**
 * In-process primitive. Caller has already resolved the candidate and
 * brought the consultant record from the router. Returns the same
 * lean envelope the HTTP handler emits: `{ok: true}` on success, or
 * `{ok: false, status, error}` on a recoverable failure.
 *
 * No echo of the candidate or RF note id — every response byte costs
 * Claude context tokens, and Claude already has the candidate identity
 * from the request. The RF note id is not used downstream.
 */
export async function addNoteForCandidate({ env, candidate, noteMd, consultant }) {
  if (!String(noteMd ?? '').trim()) {
    return { ok: false, status: 400, error: 'note is required' };
  }
  const html = mdToHtml(noteMd);
  try {
    await addRFCandidateNote(candidate.id, html, consultant.rfUserId, env);
  } catch (err) {
    console.error('add-note RF call failed:', err);
    return { ok: false, status: 502, error: 'RF notes/add failed' };
  }
  return { ok: true };
}

export async function handleCandidateAddNote({ env, body, consultant }) {
  // ─── ID short-circuit: coerce *_id fields onto fuzzy fields ─────────
  // resolveCandidate / resolveJob already short-circuit numeric inputs to
  // direct row lookups, so this single coercion is enough.
  if (body.candidate_id != null && body.candidate == null) {
    body = { ...body, candidate: Number(body.candidate_id) };
  }
  if (body.job_id != null && body.job == null) {
    body = { ...body, job: Number(body.job_id) };
  }

  // ─── Validation ─────────────────────────────────────────────────────
  if (body.candidate == null) {
    return jsonResponse(400, { error: 'candidate is required' });
  }
  const noteTrimmed = typeof body.note === 'string' ? body.note.trim() : '';
  if (!noteTrimmed) {
    return jsonResponse(400, { error: 'note is required' });
  }

  // ─── Resolve candidate ──────────────────────────────────────────────
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

  // ─── Optional job filter (auto-narrow) ──────────────────────────────
  // Notes attach to the candidate, not to a candidate-job link. `job` is
  // purely a disambiguator that drops candidates without a non-DQ link
  // to that job. Same shape as candidate-log-interview.js.
  if (body.job != null) {
    const validated = [];
    for (const c of candidateOptions) {
      const nonDq = (c.jobs ?? []).filter((j) => !j.disqualified);
      if (nonDq.length === 0) continue;
      const jobRes = await resolveJob(env, body.job, { restrictTo: nonDq });
      if (jobRes.ok || jobRes.reason === 'ambiguous') validated.push(c);
    }
    candidateOptions = validated;
  }

  if (candidateOptions.length === 0) {
    return jsonResponse(400, {
      error: 'no candidate matches the given filters',
    });
  }

  if (candidateOptions.length > 1) {
    return jsonResponse(200, {
      needs_disambiguation: true,
      kind: 'candidate',
      options: candidateOptions.map((c) => ({
        id: c.id,
        name: c.name,
        current_organization: c.current_organization ?? null,
        current_title: c.current_title ?? null,
      })),
      hint: 'Multiple candidates match — please be more specific.',
    });
  }

  // ─── Single survivor → write the note ───────────────────────────────
  const res = await addNoteForCandidate({
    env,
    candidate: candidateOptions[0],
    noteMd: noteTrimmed,
    consultant,
  });

  if (!res.ok) {
    return jsonResponse(res.status ?? 502, { error: res.error });
  }
  return jsonResponse(200, { ok: true });
}
