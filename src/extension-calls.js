/**
 * Extension call-tracker — state machine driven by Dialpad call-state webhooks.
 *
 * All state (watch + active) lives in the per-user `ExtensionCallStateChannel`
 * Durable Object. KV would race here: the calling/hangup webhook lands at one
 * Cloudflare DC and `/dialpad-hangup` lands at another, and KV's eventual
 * consistency (up to ~60s cross-DC) returns stale nulls for state read within
 * a few seconds of being written. DO storage is single-instance and
 * transactionally consistent — every read sees the same value the most recent
 * write produced.
 *
 * Flow:
 *   /dialpad-call         → stub.clearAll() + stub.setWatch({ phone })
 *   Dialpad 'calling'     → stub.getWatch() → match → stub.setActive(...)
 *                           + stub.clearWatch() + stub.pushState({state:"active"})
 *   /dialpad-hangup       → stub.getActive() → call_id used → stub.clearAll()
 *   Dialpad 'hangup'      → stub.getActive() → call_id matches →
 *                           stub.clearActive() + stub.pushState({state:"ended"})
 *
 * The extension never sees the Dialpad `call_id` — DO storage holds it and
 * `/dialpad-hangup` reads it back.
 */

import { getUserByDialpadId } from './users.js';

/**
 * Process a single Dialpad call-state event. Returns a structured outcome for
 * logging — no throwing, the webhook handler always responds 200.
 */
export async function processExtensionCallEvent(payload, env, ctx) {
  const state = payload?.state;
  const direction = payload?.direction;
  const callId = payload?.call_id;
  const externalNumber = payload?.external_number;
  // target.id arrives as a number from Dialpad; coerce for registry lookup
  const targetId = payload?.target?.id;

  if (!state || targetId === undefined || targetId === null) {
    return { processed: false, reason: 'missing required fields' };
  }

  const user = getUserByDialpadId(targetId);
  if (!user) {
    return { processed: false, reason: 'unmonitored user', targetId: String(targetId) };
  }

  const dialpadUserId = user.dialpadId;

  if (!env?.EXT_CALL_CHANNEL) {
    console.warn({
      message: '[ExtCall] EXT_CALL_CHANNEL binding missing — webhook ignored',
      source: 'extension-calls',
      dialpadUserId,
      state,
    });
    return { processed: false, reason: 'EXT_CALL_CHANNEL binding missing', dialpadUserId };
  }

  const stub = env.EXT_CALL_CHANNEL.getByName(String(dialpadUserId));

  if (state === 'calling') {
    if (direction !== 'outbound') {
      return { processed: false, reason: `non-outbound calling event (${direction})` };
    }
    const watch = await stub.getWatch();
    if (!watch) {
      return { processed: false, reason: 'no watch entry for user' };
    }
    if (externalNumber !== watch.phone) {
      return {
        processed: false,
        reason: `phone mismatch (watch=${watch.phone}, evt=${externalNumber})`,
      };
    }
    await stub.setActive({
      callId: String(callId),
      phone: externalNumber,
      startedAt: Date.now(),
    });
    await stub.clearWatch();
    await pushAndLog(stub, { state: 'active', phoneNumber: externalNumber }, dialpadUserId, callId);
    return { processed: true, transition: 'watch→active', callId: String(callId), dialpadUserId };
  }

  if (state === 'hangup') {
    const active = await stub.getActive();
    if (!active) {
      return { processed: false, reason: 'no active call for user' };
    }
    if (String(active.callId) !== String(callId)) {
      return {
        processed: false,
        reason: `call_id mismatch (active=${active.callId}, evt=${callId})`,
      };
    }
    await stub.clearActive();
    await pushAndLog(stub, { state: 'ended', phoneNumber: active.phone }, dialpadUserId, callId);
    return { processed: true, transition: 'active→ended', callId: String(callId), dialpadUserId };
  }

  return { processed: false, reason: `ignored state: ${state}` };
}

/**
 * Push a state change to the per-user DO and log the outcome.
 *
 * The payload pushed to the extension OMITS `callId` deliberately: the worker
 * owns the call_id end-to-end (stored in DO storage, used on /dialpad-hangup).
 *
 * Failures here are swallowed — the webhook handler must respond 200 to
 * Dialpad regardless of whether downstream push succeeded.
 */
async function pushAndLog(stub, event, dialpadUserId, callId) {
  console.log({
    message: `[ExtCall] notify dialpadUserId=${dialpadUserId} state=${event.state} callId=${callId}`,
    source: 'extension-calls',
    dialpadUserId,
    state: event.state,
    callId: String(callId),
    phoneNumber: event.phoneNumber,
  });
  try {
    const result = await stub.pushState(event);
    console.log({
      message: `[ExtCall] pushed state=${event.state} delivered=${result?.delivered ?? 0}`,
      source: 'extension-calls',
      dialpadUserId,
      state: event.state,
      delivered: result?.delivered ?? 0,
    });
  } catch (err) {
    console.error({
      message: `[ExtCall] DO push failed: ${err?.message || 'unknown'}`,
      source: 'extension-calls',
      dialpadUserId,
      state: event.state,
      stack: err?.stack,
    });
  }
}
