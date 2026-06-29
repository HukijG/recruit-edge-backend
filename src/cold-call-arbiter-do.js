/**
 * ColdCallArbiter — per-call Durable Object that decides whether a
 * never-connected (cancelled) outbound call should be logged as a cold call,
 * giving the transcript path strict priority regardless of event order.
 *
 * Why a DO (and not KV): a single Dialpad call can emit BOTH a `hangup` (rang
 * but never connected) AND, slightly later, a `call_transcription` (Dialpad
 * detected speech). The transcript always wins. Events can arrive out of order,
 * and RF has no activity-delete, so we cannot write-cancelled-then-undo. We need
 * a short grace window with strict read-after-write consistency to coordinate
 * the two webhook deliveries — KV's cross-PoP eventual consistency is unreliable
 * for this (it produced the same class of bug ExtCallState exists to fix).
 *
 * One instance per Dialpad `call_id`, keyed by `idFromName(String(callId))`.
 * Both webhook branches route to the same instance, so the DO's single-threaded
 * execution serializes them — no race.
 *
 * Lifetime is bounded: a record holds 2-3 flags for the grace window (then a
 * cleanup window for duplicate-delivery dedup), then self-deletes. This is a
 * grace-timer, not call-state tracking.
 *
 * The arbitration is implemented as pure functions over a `storage` interface
 * (the DurableObjectState storage) so it's unit-testable without the DO shell;
 * the class below is a thin delegator. The grace alarm and the post-finalize
 * cleanup alarm share the single DO alarm slot, distinguished by `finalized`.
 */

import { DurableObject } from 'cloudflare:workers';

// Grace window: how long a cancelled waits for a possibly-late transcript before
// being recorded. Must exceed the real call-end→call_transcription delivery lag.
// Measured 2026-06-29 from 50 recent call_transcription events (LD logs):
// p50 14s · p90 38s · p99/max 52s. 120s gives ~2.3× headroom over the observed
// max while surfacing cancelled calls within ~2 min. Re-check once Outbound
// `hangup` is live on the subscription — then measure hangup→transcript per
// call_id directly (see the cancelled-cold-calls design).
export const GRACE_MS = 120 * 1000; // 2 min
// After finalize, keep the record this long so duplicate Dialpad hangup
// deliveries don't double-record. Then the DO self-deletes.
export const CLEANUP_MS = 60 * 60 * 1000; // 1h

const K_TRANSCRIPT = 'transcriptSeen';
const K_CANCELLED = 'cancelledPayload';
const K_FINALIZED = 'finalized';

function logState(state, callId) {
  console.log({ message: `[ColdCallArbiter] ${state}`, source: 'cold-call-arbiter', state, callId: callId != null ? String(callId) : null });
}

/**
 * A transcript (voicemail or live) arrived for this call. Transcript always
 * wins — suppress any cancelled, now or later.
 */
export async function arbiterMarkTranscript(storage, callId, now = Date.now()) {
  if (await storage.get(K_FINALIZED)) {
    return { ok: true, state: 'already-finalized' };
  }
  await storage.put(K_TRANSCRIPT, true);

  const pending = await storage.get(K_CANCELLED);
  if (pending) {
    // Cancelled was waiting out its grace — the transcript supersedes it.
    await storage.delete(K_CANCELLED);
    await storage.put(K_FINALIZED, true);
    await storage.setAlarm(now + CLEANUP_MS);
    logState('superseded-pending-cancelled', callId);
    return { ok: true, state: 'superseded' };
  }
  // Lone transcript (the common case). Keep the flag briefly to catch a
  // reordered late hangup, then self-delete.
  await storage.setAlarm(now + GRACE_MS);
  logState('transcript-marked', callId);
  return { ok: true, state: 'transcript-marked' };
}

/**
 * A never-connected outbound hangup arrived. Arm the grace timer; arbiterAlarm
 * records it unless a transcript shows up first.
 */
export async function arbiterMarkCancelled(storage, payload, now = Date.now()) {
  const callId = payload?.callId;
  if (await storage.get(K_FINALIZED)) {
    return { ok: true, state: 'suppressed-finalized' };
  }
  if (await storage.get(K_TRANSCRIPT)) {
    logState('suppressed-transcript-won', callId);
    return { ok: true, state: 'suppressed-transcript' };
  }
  if (await storage.get(K_CANCELLED)) {
    return { ok: true, state: 'already-pending' }; // duplicate hangup delivery
  }
  await storage.put(K_CANCELLED, payload);
  await storage.setAlarm(now + GRACE_MS);
  logState('cancelled-pending', callId);
  return { ok: true, state: 'cancelled-pending' };
}

/**
 * Alarm handler. Either the grace timer (record the cancelled unless a
 * transcript arrived) or the post-finalize cleanup timer (wipe + let the DO go).
 */
export async function arbiterAlarm(storage, env, now = Date.now()) {
  // Cleanup alarm (set after finalize/supersede) — wipe and let the DO go.
  if (await storage.get(K_FINALIZED)) {
    await storage.deleteAll();
    return { action: 'cleanup' };
  }
  // Lone-transcript grace expired (no cancelled to record) — wipe.
  if (await storage.get(K_TRANSCRIPT)) {
    await storage.deleteAll();
    return { action: 'transcript-expired' };
  }
  const payload = await storage.get(K_CANCELLED);
  if (!payload) {
    await storage.deleteAll();
    return { action: 'noop' };
  }

  // Grace elapsed with no transcript → record the cancelled cold call. Route
  // through the worker's own instrumented fetch handler (SELF binding) so the
  // finalize runs in a fully-traced context, span-linked back to the originating
  // webhook via the _otel_trace param in finalizeUrl.
  try {
    const res = await env.SELF.fetch(payload.finalizeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': env.INTERNAL_SECRET || '',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error({ message: `[ColdCallArbiter] finalize non-OK: ${res.status} ${body.slice(0, 160)}`, source: 'cold-call-arbiter', callId: payload.callId, status: res.status });
    } else {
      logState('finalized', payload.callId);
    }
  } catch (err) {
    // Fail-fast tolerance matches the live cold-call flow: a failed finalize
    // drops this cancelled rather than retry-storming. Logged for visibility.
    console.error({ message: `[ColdCallArbiter] finalize fetch failed: ${err.message}`, source: 'cold-call-arbiter', callId: payload.callId });
  }

  await storage.delete(K_CANCELLED);
  await storage.put(K_FINALIZED, true);
  await storage.setAlarm(now + CLEANUP_MS);
  return { action: 'finalized' };
}

export class ColdCallArbiter extends DurableObject {
  markTranscript(callId) {
    return arbiterMarkTranscript(this.ctx.storage, callId);
  }
  markCancelled(payload) {
    return arbiterMarkCancelled(this.ctx.storage, payload);
  }
  alarm() {
    return arbiterAlarm(this.ctx.storage, this.env);
  }
}
