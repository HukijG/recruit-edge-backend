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
import { resolveCandidate } from './resolvers.js';
import { resolveTimeWindow } from './call-notes-time.js';
import { CALL_NOTES_GUIDANCE } from './call-notes-guidance.js';
import { listDialpadCalls, DialpadHttpError } from '../dialpad-client.js';
import { extractRFIdFromDialpadContact } from '../rf-client.js';

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
      return jsonResponse(200, {
        needs_disambiguation: true,
        kind: 'candidate',
        options: candRes.options,
        hint: candRes.hint,
      });
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
  return jsonResponse(200, out);
}

export async function handleCandidateCallNotes({ env, body, consultant }) {
  if (body?.step === 'list_calls') {
    return handleListCalls({ env, body, consultant });
  }
  // Other step handlers wired in Tasks 6–7. Until then, every other step
  // returns the canonical "unknown step" 400.
  return jsonResponse(400, { error: 'step must be one of list_calls, get_transcript, submit_notes' });
}
