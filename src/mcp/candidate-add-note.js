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
import { resolveCandidateThin, resolveJob } from './resolvers.js';
import { mdToHtml } from './markdown.js';
import {
  addRFCandidateNote,
  getRFCandidate,
  RFRateLimitedError,
} from '../rf-client.js';
import { pMapLimit } from './concurrency.js';

const HYDRATION_CONCURRENCY = 8;

/**
 * In-process primitive. Caller has already resolved the candidate and
 * brought the consultant record from the router. Returns the same
 * lean envelope the HTTP handler emits: `{ok: true}` on success, or
 * `{ok: false, kind, error}` on a recoverable failure.
 *
 * Recoverable shape mirrors the project-wide lean envelope:
 *   • RF rate-limit → `kind: 'rate_limited'`, `recoverable: false`,
 *     `retry_after_ms`.
 *   • RF transient / other → `kind: 'rf_unavailable'`, `recoverable: true`.
 *   • Empty note → `kind: 'invalid_input'`, HTTP 400 upstream.
 */
export async function addNoteForCandidate({ env, candidate, noteMd, consultant }) {
  if (!String(noteMd ?? '').trim()) {
    return { ok: false, status: 400, kind: 'invalid_input', error: 'note is required' };
  }
  const html = mdToHtml(noteMd);
  try {
    await addRFCandidateNote(candidate.id, html, consultant.rfUserId, env);
  } catch (err) {
    console.error({ source: 'mcp-add-note', message: 'add-note RF call failed', error: err?.message ?? String(err) });
    if (err instanceof RFRateLimitedError) {
      return {
        ok: false,
        status: 200,
        kind: 'rate_limited',
        recoverable: false,
        retry_after_ms: err.retryAfterMs ?? null,
        error: 'RF rate limited',
      };
    }
    return { ok: false, status: 200, kind: 'rf_unavailable', recoverable: true, error: 'RF notes/add failed' };
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
  // Thin resolve only — notes only need candidate.id + name. The optional
  // `job` filter triggers per-option live-fetches below (jobs[] is mutable
  // → not cached).
  let candRes;
  try {
    candRes = await resolveCandidateThin(env, body.candidate);
  } catch (e) {
    if (e instanceof RFRateLimitedError) {
      return jsonResponse(200, {
        ok: false,
        kind: 'rate_limited',
        recoverable: false,
        retry_after_ms: e.retryAfterMs ?? null,
        error: 'RF rate limited',
      });
    }
    return jsonResponse(200, {
      ok: false,
      kind: 'rf_unavailable',
      recoverable: true,
      error: e?.message ?? String(e),
    });
  }
  let candidateOptions;
  if (candRes.ok) {
    const t = candRes.value;
    candidateOptions = [{
      id: t.id,
      name: t.name,
      current_organization: t.current_company_at_cache_time ?? null,
      current_title: t.current_title_at_cache_time ?? null,
    }];
  } else if (candRes.reason === 'ambiguous') {
    candidateOptions = candRes.options.map((o) => ({
      id: o.id,
      name: o.name,
      current_organization: o.current_organization ?? null,
      current_title: o.current_title ?? null,
    }));
  } else {
    // Lean envelope: HTTP 200 + {ok:false, kind:'no_candidate'} — consistent
    // with the rest of the system. The consumer apologises + asks for a
    // better-narrowed reference rather than crashing on a 404.
    return jsonResponse(200, { ok: false, kind: 'no_candidate', error: 'candidate not found' });
  }

  // ─── Optional job filter (auto-narrow) ──────────────────────────────
  // Notes attach to the candidate, not to a candidate-job link. `job` is
  // purely a disambiguator that drops candidates without a non-DQ link
  // to that job. jobs[] is mutable → live-fetch per option.
  if (body.job != null) {
    const bodies = await pMapLimit(
      candidateOptions.map((c) => c.id),
      HYDRATION_CONCURRENCY,
      async (id) => getRFCandidate(id, env),
    );
    const validated = [];
    for (let i = 0; i < candidateOptions.length; i++) {
      const r = bodies[i];
      if (!r.ok) continue;
      const fullBody = r.value;
      const nonDq = (fullBody.jobs ?? []).filter((j) => !j.disqualified);
      if (nonDq.length === 0) continue;
      const jobRes = await resolveJob(env, body.job, { restrictTo: nonDq });
      if (jobRes.ok || jobRes.reason === 'ambiguous') validated.push(candidateOptions[i]);
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
    // Lean envelope: HTTP 200 + {ok:false, kind, error}. 400 stays 400 for
    // hard-input violations (empty note).
    if (res.status === 400) {
      return jsonResponse(400, { ok: false, kind: res.kind ?? 'invalid_input', error: res.error });
    }
    const payload = { ok: false, kind: res.kind ?? 'rf_unavailable', error: res.error };
    if (res.recoverable != null) payload.recoverable = res.recoverable;
    if (res.retry_after_ms != null) payload.retry_after_ms = res.retry_after_ms;
    return jsonResponse(200, payload);
  }
  return jsonResponse(200, { ok: true });
}
