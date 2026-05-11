/**
 * /mcp/candidate-call-notes — three-stage Dialpad-call → structured RF note.
 *
 * One endpoint, dispatched by body.step:
 *   - 'list_calls'    → handleListCalls: list the consultant's recent ≥2min Dialpad calls with one candidate
 *   - 'get_transcript'→ handleGetTranscript: pull the transcript + render brief for one chosen call
 *   - 'submit_notes'  → handleSubmitNotes: post the structured markdown notes to RF
 *
 * Step branching keeps the workflow visible as one MCP tool while the server
 * dispatches to three crisp handlers. Each handler returns the lean envelope
 * shape (HTTP 200 + {ok: false, kind, error} for recoverable failures; 4xx /
 * 5xx for install / transport errors only).
 *
 * Spec: the candidate-call-notes design (2026-05-10).
 */

import { jsonResponse } from './router.js';
import { resolveCandidate, disambiguationPayload } from './resolvers.js';
import { resolveTimeWindow } from './call-notes-time.js';
import { CALL_NOTES_GUIDANCE } from './call-notes-guidance.js';
import { listDialpadCalls, getDialpadCall, DialpadHttpError } from '../dialpad-client.js';
import { extractRFIdFromDialpadContact } from '../rf-client.js';
import { getCandidateById } from './d1-read.js';
import { fetchCallTranscript } from '../cold-call.js';
import { addNoteForCandidate, handleCandidateAddNote } from './candidate-add-note.js';

export const MIN_TOTAL_DURATION_MS = 120_000;
export const MAX_LIST_PAGES = 20;

/**
 * Pure function: take Dialpad's transcript.lines[] array and render only the
 * spoken lines as "Name: content", one per line.
 *
 * Drops every line where type !== 'transcript' (the 'moment' annotations Dialpad
 * emits: voicemail, call_purpose_category, ner, speaking_too_quickly, etc.).
 */
export function formatTranscript(lines) {
  if (!Array.isArray(lines)) return '';
  return lines
    .filter((l) => l && l.type === 'transcript')
    .map((l) => `${l.name ?? 'Unknown'}: ${l.content ?? ''}`)
    .join('\n');
}

/**
 * Render a Dialpad ms-since-epoch timestamp (often delivered as a string) as
 * ISO 8601 with a `+00:00` suffix. Matches the wire format we emit for every
 * call timestamp the MCP returns to Claude.
 */
function isoFromMs(ms) {
  return new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Step 1 of the three-stage flow: list the consultant's calls with one
 * candidate inside a time window, filtered to ≥ 2-minute calls.
 *
 * Order of operations (identity guard first, then input validation, then
 * candidate resolution, then Dialpad call):
 *
 *   1. `consultant.dialpadId` missing → ok:false, kind:'no_dialpad_id'.
 *   2. `body.candidate` missing → 400.
 *   3. `resolveCandidate` ambiguous → needs_disambiguation envelope.
 *      `resolveCandidate` not_found → ok:false, kind:'no_candidate'.
 *   4. Paginate /api/v2/call until cursor is null OR MAX_LIST_PAGES.
 *   5. Filter by RF candidate id extracted from `contact.id` AND
 *      `total_duration >= MIN_TOTAL_DURATION_MS`.
 *   6. Sort DESC by `date_started`, project to {call_id, started_at,
 *      duration_minutes, direction}.
 *
 * `window` is OMITTED on success when `tw.source === 'iso'` (Claude already
 * has the bounds — no point echoing them). On `no_long_calls` the window is
 * always included so Claude can surface "expand from X to Y" to the user.
 */
async function handleListCalls({ env, body, consultant }) {
  if (!consultant.dialpadId) {
    return jsonResponse(200, {
      ok: false,
      kind: 'no_dialpad_id',
      error: 'Your consultant record has no Dialpad user id; ask Joel to update the team registry.',
    });
  }
  if (body.candidate == null) {
    return jsonResponse(400, { error: 'candidate is required for step=list_calls' });
  }

  const candRes = await resolveCandidate(env, body.candidate);
  if (!candRes.ok) {
    if (candRes.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(candRes));
    }
    return jsonResponse(200, {
      ok: false,
      kind: 'no_candidate',
      error: 'candidate not found',
    });
  }
  const candidate = candRes.value;

  const tw = resolveTimeWindow(body);

  // Paginate Dialpad calls. Bail at MAX_LIST_PAGES with a warning so a too-wide
  // window doesn't keep us in here forever — Claude can narrow and retry.
  const items = [];
  let cursor = null;
  let pages = 0;
  const warnings = [...tw.warnings];
  try {
    while (true) {
      const page = await listDialpadCalls({
        targetId: consultant.dialpadId,
        targetType: 'user',
        startedAfterMs: tw.startedAfterMs,
        startedBeforeMs: tw.startedBeforeMs,
        cursor,
      }, env);
      pages += 1;
      items.push(...page.items);
      cursor = page.cursor || null;
      if (!cursor) break;
      if (pages >= MAX_LIST_PAGES) {
        warnings.push(`hit pagination cap (${MAX_LIST_PAGES} pages); narrow the time range`);
        break;
      }
    }
  } catch (err) {
    if (err instanceof DialpadHttpError) {
      return jsonResponse(502, { error: `Dialpad list-calls failed: ${err.status}` });
    }
    throw err;
  }

  // Filter: matching candidate (RF id parsed from shared-pool contact id) and
  // total_duration ≥ 2 min. Live Dialpad payloads emit fractional ms for
  // total_duration (e.g. 68286.025) — Number coercion handles it cleanly.
  const candIdStr = String(candidate.id);
  const surviving = items.filter((c) => {
    const rfId = extractRFIdFromDialpadContact(c?.contact?.id);
    if (rfId == null || String(rfId) !== candIdStr) return false;
    const td = Number(c?.total_duration ?? 0);
    return Number.isFinite(td) && td >= MIN_TOTAL_DURATION_MS;
  });

  // Sort newest-first by date_started (also string-typed in live payloads).
  surviving.sort((a, b) => Number(b.date_started) - Number(a.date_started));

  const window = {
    started_after: isoFromMs(tw.startedAfterMs),
    started_before: isoFromMs(tw.startedBeforeMs),
  };

  if (surviving.length === 0) {
    const out = {
      ok: false,
      kind: 'no_long_calls',
      error: `No calls of 2+ minutes found for ${candidate.name} in this window. Try widening the time range.`,
      window,
    };
    if (warnings.length) out._meta = { warnings };
    return jsonResponse(200, out);
  }

  const calls = surviving.map((c) => ({
    call_id: String(c.call_id),
    started_at: isoFromMs(c.date_started),
    duration_minutes: Math.round(Number(c.total_duration) / 60_000),
    direction: c.direction,
  }));

  const out = {
    ok: true,
    candidate: { id: candidate.id, name: candidate.name },
    calls,
  };
  // window is omitted on success when Claude supplied verbatim ISO bounds —
  // no point echoing them back. Included otherwise so Claude can surface
  // "searched X → Y" to the user.
  if (tw.source !== 'iso') {
    out.window = window;
  }
  if (warnings.length) out._meta = { warnings };
  console.log({
    message: `[mcp] candidate-call-notes step=list_calls candidate_id=${candidate.id} calls=${calls.length}`,
    tool: '/mcp/candidate-call-notes',
    step: 'list_calls',
    candidate_id: candidate.id,
    calls_returned: calls.length,
  });
  return jsonResponse(200, out);
}

/**
 * Step 2 of the three-stage flow: fetch one call, verify the consultant owns
 * it (target.id match), resolve the linked RF candidate, then fetch and format
 * the transcript.
 *
 * Order of operations matters for per-record authorization:
 *
 *   1. `consultant.dialpadId` missing → ok:false, kind:'no_dialpad_id'.
 *   2. `body.call_id` missing → 400.
 *   3. GET /call/{id} — 429 → rate_limited; 4xx → call_not_found; 5xx → 502.
 *   4. `call.target.id !== consultant.dialpadId` → ok:false, kind:'not_your_call'.
 *      MUST run before the transcript fetch — knowing a call_id should not be
 *      enough to read any teammate's transcript.
 *   5. `extractRFIdFromDialpadContact` on `call.contact.id` — null → no_rf_candidate.
 *   6. `getCandidateById` from D1 — null → no_candidate (cache miss).
 *   7. `fetchCallTranscript` — DialpadHttpError 404 → no_transcript; other non-2xx → 502.
 *   8. `formatTranscript` produces empty string (moments-only transcript) → no_transcript.
 *   9. Success: candidate id+name, lean call summary, formatted transcript text,
 *      and the CALL_NOTES_GUIDANCE markdown brief Claude uses to structure notes.
 */
async function handleGetTranscript({ env, body, consultant }) {
  if (!consultant.dialpadId) {
    return jsonResponse(200, {
      ok: false,
      kind: 'no_dialpad_id',
      error: 'Your consultant record has no Dialpad user id; ask Joel to update the team registry.',
    });
  }
  const callId = body.call_id;
  if (typeof callId !== 'string' || !callId) {
    return jsonResponse(400, { error: 'call_id is required for step=get_transcript' });
  }

  let call;
  try {
    call = await getDialpadCall(callId, env);
  } catch (err) {
    if (err instanceof DialpadHttpError) {
      if (err.status === 429) {
        return jsonResponse(200, {
          ok: false,
          kind: 'rate_limited',
          error: 'Dialpad rate-limit — try again in a moment.',
        });
      }
      if (err.status >= 400 && err.status < 500) {
        return jsonResponse(200, {
          ok: false,
          kind: 'call_not_found',
          error: 'Call not found on Dialpad.',
        });
      }
      return jsonResponse(502, { error: `Dialpad get-call failed: ${err.status}` });
    }
    throw err;
  }

  // Per-record authorization: only the user whose Dialpad line is on `target`
  // may read this call's transcript. Runs BEFORE the transcript fetch so a
  // stolen call_id can't leak a teammate's transcript.
  if (String(call?.target?.id ?? '') !== String(consultant.dialpadId)) {
    return jsonResponse(200, {
      ok: false,
      kind: 'not_your_call',
      error: 'This call is not on your Dialpad line.',
    });
  }

  const rfId = extractRFIdFromDialpadContact(call?.contact?.id);
  if (rfId == null) {
    return jsonResponse(200, {
      ok: false,
      kind: 'no_rf_candidate',
      error: 'This call is not linked to an RF candidate.',
    });
  }

  const candidate = await getCandidateById(env, Number(rfId));
  if (!candidate) {
    return jsonResponse(200, {
      ok: false,
      kind: 'no_candidate',
      error: 'Linked RF candidate not in the cache; ask the sync worker to rebuild.',
    });
  }

  let transcript;
  try {
    transcript = await fetchCallTranscript(callId, env);
  } catch (err) {
    // fetchCallTranscript throws DialpadHttpError on non-2xx — branch on the
    // status code, no string-matching.
    if (err instanceof DialpadHttpError && err.status === 404) {
      return jsonResponse(200, {
        ok: false,
        kind: 'no_transcript',
        error: 'No transcript exists yet for this call. Dialpad usually publishes transcripts within a few minutes of hangup.',
      });
    }
    const status = err instanceof DialpadHttpError ? err.status : '?';
    return jsonResponse(502, { error: `Dialpad transcript fetch failed: ${status}` });
  }

  const text = formatTranscript(transcript?.lines);
  if (!text) {
    return jsonResponse(200, {
      ok: false,
      kind: 'no_transcript',
      error: 'Transcript exists but contains no spoken lines (moments only).',
    });
  }

  console.log({
    message: `[mcp] candidate-call-notes step=get_transcript candidate_id=${candidate.id} transcript_chars=${text.length}`,
    tool: '/mcp/candidate-call-notes',
    step: 'get_transcript',
    candidate_id: candidate.id,
    transcript_chars: text.length,
  });
  return jsonResponse(200, {
    ok: true,
    candidate: { id: candidate.id, name: candidate.name },
    call: {
      call_id: String(call.call_id),
      started_at: isoFromMs(call.date_started),
      duration_minutes: Math.round(Number(call.total_duration ?? 0) / 60_000),
      direction: call.direction,
    },
    transcript: text,
    guidance: CALL_NOTES_GUIDANCE,
  });
}

/**
 * Step 3 of the three-stage flow: post the structured-markdown notes to RF as
 * a candidate timeline note. Two paths:
 *
 *   - Fast path  (candidate_id numeric): D1 lookup → `addNoteForCandidate`
 *     in-process. No fuzzy resolution, no disambiguation envelope. Cache miss
 *     surfaces as `{ok: false, kind: 'no_candidate'}` (HTTP 200) — the user
 *     just chose this candidate in step 1 / step 2, so the right UX is "the
 *     cache forgot, try again" not "candidate not found."
 *
 *   - Fallback path (candidate_fallback fuzzy string): delegates the whole
 *     candidate-resolution flow to `handleCandidateAddNote` verbatim. The
 *     sibling's behavior — needs_disambiguation envelope, HTTP 404 +
 *     `{error: 'candidate not found'}` on resolver miss — flows through
 *     unchanged. Dialect divergence vs. the fast path's HTTP-200 envelope is
 *     deliberate: see spec § "Note on the candidate_id-not-in-D1 dialect".
 *
 * Attribution is always `consultant.rfUserId` (resolved server-side from the
 * Access JWT). Both paths funnel the inbound `note` straight to
 * `addNoteForCandidate`, which is the ONLY caller of `addRFCandidateNote` for
 * this endpoint — no `user` / `activity_user_id` / `created_by` body field
 * has any reach, by construction.
 */
async function handleSubmitNotes({ env, body, consultant }) {
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) {
    return jsonResponse(400, { error: 'note is required' });
  }
  const hasId = body.candidate_id != null;
  const hasFallback = body.candidate_fallback != null;
  if (hasId && hasFallback) {
    return jsonResponse(400, {
      error: 'pass exactly one of candidate_id (numeric) or candidate_fallback (fuzzy ref) — not both',
    });
  }
  if (!hasId && !hasFallback) {
    return jsonResponse(400, {
      error: 'candidate_id (numeric) or candidate_fallback (fuzzy ref) is required for step=submit_notes',
    });
  }

  if (hasId) {
    const candidate = await getCandidateById(env, Number(body.candidate_id));
    if (!candidate) {
      return jsonResponse(200, {
        ok: false,
        kind: 'no_candidate',
        error: 'candidate not found',
      });
    }
    const res = await addNoteForCandidate({ env, candidate, noteMd: note, consultant });
    if (!res.ok) {
      return jsonResponse(res.status ?? 502, { error: res.error });
    }
    console.log({
      message: `[mcp] candidate-call-notes step=submit_notes candidate_id=${candidate.id} note_chars=${note.length}`,
      tool: '/mcp/candidate-call-notes',
      step: 'submit_notes',
      candidate_id: candidate.id,
      note_chars: note.length,
    });
    return jsonResponse(200, { ok: true });
  }

  // Fallback path: delegate to /mcp/candidate-add-note's handler verbatim so
  // disambiguation / not-found behave identically to the sibling tool.
  //
  // Dialect note: the sibling returns HTTP 404 + {error: 'candidate not found'}
  // on resolver not_found, whereas the fast path above returns HTTP 200 + the
  // {ok: false, kind: 'no_candidate'} envelope. The asymmetry is deliberate —
  // see spec § "Note on the candidate_id-not-in-D1 dialect". Preserving the
  // sibling's shape on this path means the fallback is a true passthrough.
  return handleCandidateAddNote({
    env,
    body: { candidate: body.candidate_fallback, note },
    consultant,
  });
}

export async function handleCandidateCallNotes({ env, body, consultant }) {
  if (body?.step === 'list_calls') return handleListCalls({ env, body, consultant });
  if (body?.step === 'get_transcript') return handleGetTranscript({ env, body, consultant });
  if (body?.step === 'submit_notes') return handleSubmitNotes({ env, body, consultant });
  return jsonResponse(400, { error: 'step must be one of list_calls, get_transcript, submit_notes' });
}
