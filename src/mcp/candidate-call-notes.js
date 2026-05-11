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

export async function handleCandidateCallNotes({ env, body, consultant }) {
  // Step handlers wired in Tasks 5–7. Until then, every step returns the
  // canonical "unknown step" 400 so integration tests against unimplemented
  // steps see a clean negative response (not a 501/placeholder/404).
  return jsonResponse(400, { error: 'step must be one of list_calls, get_transcript, submit_notes' });
}
