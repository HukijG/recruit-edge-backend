/**
 * Extension call-tracker — state machine driven by Dialpad call-state webhooks.
 *
 * Flow:
 *   /dialpad-call         → writes extcall:watch:{userId} = { phone }
 *   Dialpad 'calling'     → matches watch.phone → writes extcall:active:{userId}
 *                           = { callId } and pushes {state:"active"} to extension
 *   /dialpad-hangup       → reads active.callId, calls Dialpad hangup, clears active
 *   Dialpad 'hangup'      → matches active.callId → clears active and pushes
 *                           {state:"ended"} to extension (handles "hung up elsewhere")
 *
 * The extension never sees the Dialpad call_id — we hold it in active KV and
 * read it back on /dialpad-hangup. The button toggle (Call ↔ Hangup) is driven
 * by the SSE state events `notifyExtensionCallState` produces (currently a
 * stub; will fan into a Durable-Object-backed SSE channel keyed by
 * dialpadUserId in the next pass).
 */

import { getUserByDialpadId } from './users.js';
import {
  getExtensionCallWatch, clearExtensionCallWatch,
  setActiveExtensionCall, getActiveExtensionCall, clearActiveExtensionCall,
} from './cache.js';

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

  if (state === 'calling') {
    if (direction !== 'outbound') {
      return { processed: false, reason: `non-outbound calling event (${direction})` };
    }
    const watch = await getExtensionCallWatch(dialpadUserId, env);
    if (!watch) {
      return { processed: false, reason: 'no watch entry for user' };
    }
    if (externalNumber !== watch.phone) {
      return {
        processed: false,
        reason: `phone mismatch (watch=${watch.phone}, evt=${externalNumber})`,
      };
    }
    await setActiveExtensionCall(dialpadUserId, callId, externalNumber, env);
    await clearExtensionCallWatch(dialpadUserId, env);
    await notifyExtensionCallState({
      dialpadUserId,
      state: 'active',
      callId: String(callId),
      phoneNumber: externalNumber,
    }, env, ctx);
    return { processed: true, transition: 'watch→active', callId: String(callId), dialpadUserId };
  }

  if (state === 'hangup') {
    const active = await getActiveExtensionCall(dialpadUserId, env);
    if (!active) {
      return { processed: false, reason: 'no active call for user' };
    }
    if (String(active.callId) !== String(callId)) {
      return {
        processed: false,
        reason: `call_id mismatch (active=${active.callId}, evt=${callId})`,
      };
    }
    await clearActiveExtensionCall(dialpadUserId, env);
    await notifyExtensionCallState({
      dialpadUserId,
      state: 'ended',
      callId: String(callId),
      phoneNumber: active.phone,
    }, env, ctx);
    return { processed: true, transition: 'active→ended', callId: String(callId), dialpadUserId };
  }

  return { processed: false, reason: `ignored state: ${state}` };
}

/**
 * Push a state change to the extension via the per-user SSE Durable Object.
 *
 * The DO is keyed deterministically by `dialpadUserId` — `getByName(id)` —
 * so all browser tabs subscribed for this consultant receive the event. The
 * payload pushed to the extension OMITS `callId` deliberately: the worker
 * owns the call_id end-to-end (stored in extcall:active KV, used on
 * /dialpad-hangup). The extension only needs to know the state.
 *
 * Failures here are swallowed — the webhook handler must respond 200 to
 * Dialpad regardless of whether downstream push succeeded. CF Logs carry
 * the failure for debugging.
 */
export async function notifyExtensionCallState({ dialpadUserId, state, callId, phoneNumber }, env, ctx) {
  console.log({
    message: `[ExtCall] notify dialpadUserId=${dialpadUserId} state=${state} callId=${callId}`,
    source: 'extension-calls',
    dialpadUserId,
    state,
    callId,
    phoneNumber,
  });

  if (!env?.EXT_CALL_CHANNEL) {
    // Test envs (and any deploy where the DO binding isn't yet wired) can
    // miss this binding — bail rather than throw so the webhook still 200s.
    console.warn({
      message: '[ExtCall] EXT_CALL_CHANNEL binding missing — push skipped',
      source: 'extension-calls',
      dialpadUserId,
      state,
    });
    return;
  }

  try {
    const stub = env.EXT_CALL_CHANNEL.getByName(String(dialpadUserId));
    const result = await stub.pushState({ state, phoneNumber });
    console.log({
      message: `[ExtCall] pushed state=${state} delivered=${result?.delivered ?? 0}`,
      source: 'extension-calls',
      dialpadUserId,
      state,
      delivered: result?.delivered ?? 0,
    });
  } catch (err) {
    console.error({
      message: `[ExtCall] DO push failed: ${err.message}`,
      source: 'extension-calls',
      dialpadUserId,
      state,
      stack: err.stack,
    });
  }
}
