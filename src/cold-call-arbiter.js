/**
 * Cold-call arbiter dispatch — routes Dialpad call webhook events to the
 * per-call `ColdCallArbiter` Durable Object (src/cold-call-arbiter-do.js).
 *
 *   - transcription / call_transcription → signalTranscriptToArbiter (the call
 *     produced a transcript → suppress any cancelled for the same call).
 *   - hangup (outbound, never-connected, monitored, RF-mapped) → routeHangupToArbiter
 *     (arm the grace timer to record a cancelled cold call).
 *
 * Mirrors src/extension-calls.js (the ExtCallState dispatcher) — keeps the
 * webhook handler in index.js thin.
 */

import { isMonitoredDialpadUser } from './users.js';
import { extractRFIdFromDialpadContact } from './rf-client.js';
import { makeAsyncCallbackUrl } from './lib/trace-link.js';

// Reached via the SELF service binding — host is arbitrary, only path+query matter.
const FINALIZE_PATH = 'http://internal/internal/coldcall/finalize-cancelled';

function arbiterStub(env, callId) {
  const id = env.COLD_CALL_ARBITER.idFromName(String(callId));
  return env.COLD_CALL_ARBITER.get(id);
}

/**
 * Tell a call's arbiter that a transcript arrived — transcript always wins, so
 * any cancelled for the same call is suppressed. Safe to call for every
 * transcription / call_transcription event regardless of classification.
 */
export async function signalTranscriptToArbiter(payload, env) {
  const callId = payload?.call_id;
  if (callId == null) return { signalled: false, reason: 'no-callid' };
  const res = await arbiterStub(env, callId).markTranscript(String(callId));
  return { signalled: true, callId: String(callId), state: res?.state };
}

/**
 * Handle a `hangup` event. Arm the arbiter only for a monitored outbound call
 * that rang but never connected (no talk time) and maps to an RF candidate —
 * those are the cancelled-call candidates the live flow misses.
 *
 * Never-connected signal: Dialpad's `duration` is talk time (excludes ring),
 * 0/absent when the call never connected. (The call object has NO `date_connected`
 * field — verified against the live /call payload.) Connected calls AND outbound
 * voicemails-left both have `duration > 0` and produce a transcript, so the
 * transcript path handles them; only no-talk hangups are cancelled candidates.
 * If `duration` is absent we err toward arming (transcript-supersede covers the
 * connected case; the rare connected-without-transcript is the documented edge).
 */
export async function routeHangupToArbiter(payload, env) {
  const callId = payload?.call_id;
  if (callId == null) return { armed: false, reason: 'no-callid' };
  if (payload?.direction !== 'outbound') return { armed: false, reason: 'not-outbound', callId: String(callId) };
  const talkMs = Number(payload?.duration);
  if (Number.isFinite(talkMs) && talkMs > 0) return { armed: false, reason: 'connected', callId: String(callId) };

  if (!await isMonitoredDialpadUser(env, payload?.target?.id)) {
    return { armed: false, reason: 'unmonitored-target', callId: String(callId) };
  }

  const rfCandidateId = extractRFIdFromDialpadContact(payload?.contact?.id);
  if (!rfCandidateId) return { armed: false, reason: 'no-rf-candidate', callId: String(callId) };

  // Built in the webhook context so makeAsyncCallbackUrl captures the active
  // trace id — the DO replays this URL later to span-link the finalize back here.
  const finalizeUrl = makeAsyncCallbackUrl(FINALIZE_PATH, {});

  const arbiterPayload = {
    rfCandidateId,
    dialpadUserId: payload?.target?.id,
    callId: String(callId),
    callTimeMs: payload?.date_started ?? payload?.event_timestamp ?? Date.now(),
    contactName: payload?.contact?.name ?? null,
    finalizeUrl,
  };

  const res = await arbiterStub(env, callId).markCancelled(arbiterPayload);
  return { armed: res?.state === 'cancelled-pending', state: res?.state, callId: String(callId), rfCandidateId };
}
