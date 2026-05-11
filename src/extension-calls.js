/**
 * Extension call-state webhook handler.
 *
 * Dispatches Dialpad call-state events to the per-user `ExtCallState`
 * Durable Object (strong consistency — see src/extension-call-do.js).
 * The polling endpoint and request-driven endpoints don't write here;
 * only this handler does.
 *
 *   - `calling` event for a monitored outbound call → DO.setCallId(call_id)
 *     (overwrite-on-write — a new call replaces any prior record).
 *   - `hangup` event whose call_id matches what's stored → DO.clearCallIdIfMatch(call_id).
 *     Mismatched call_id is dropped silently (protects against stale-event
 *     races where an old hangup arrives after a new call's calling event).
 *   - Anything else (`connected`, `voicemail`, inbound, unmonitored target)
 *     → drop silently with a structured-log explanation.
 */

import { getUserByDialpadId } from './users.js';
import { incrementDailyCallCount } from './cache.js';
import { forwardHangupToSyncWorker } from './webhook/dialpad-hangup-forwarder.js';

const ACTIVE_TRIGGER_STATES = new Set(['calling']);
const TERMINAL_STATES = new Set(['hangup']);

function getDOStub(env, dialpadUserId) {
  const id = env.EXT_CALL_STATE.idFromName(dialpadUserId);
  return env.EXT_CALL_STATE.get(id);
}

export async function processExtensionCallEvent(payload, env) {
  const direction = payload?.direction;
  const targetId = payload?.target?.id;
  const eventState = payload?.state;
  const eventCallId = payload?.call_id !== undefined && payload?.call_id !== null
    ? String(payload.call_id)
    : null;

  if (direction !== 'outbound') {
    return { processed: false, reason: 'not-outbound', eventState, eventCallId };
  }
  if (!eventCallId) {
    return { processed: false, reason: 'no-callid-in-payload', eventState };
  }

  const user = await getUserByDialpadId(env, targetId);
  if (!user) {
    return { processed: false, reason: 'unmonitored-target', targetId, eventState, eventCallId };
  }

  const stub = getDOStub(env, user.dialpadId);

  if (ACTIVE_TRIGGER_STATES.has(eventState)) {
    await stub.setCallId(eventCallId);
    return {
      processed: true,
      reason: 'set-active',
      targetId,
      dialpadUserId: user.dialpadId,
      callId: eventCallId,
      eventState,
    };
  }

  if (TERMINAL_STATES.has(eventState)) {
    // Fire-and-forget forward to sync-worker for the calls cache.
    // Failures are logged in the forwarder; cron backfill (tailSyncCallsThin)
    // catches dropped messages within 15 min.
    void forwardHangupToSyncWorker(payload, env);

    // Bump the daily call counter for every monitored outbound hangup,
    // regardless of whether the DO has a matching call_id. We want this to
    // catch calls placed via the Dialpad app (no calling event for the DO,
    // but the hangup still fires) — those still count as "calls done today"
    // for the consultant's productivity stats.
    let dailyCount = null;
    try {
      dailyCount = await incrementDailyCallCount(user.rfUserId, env);
    } catch (err) {
      // Counter failure is non-fatal — log and proceed with the DO clear.
      console.error({
        message: `[ExtensionCalls] daily-counter increment failed: ${err.message}`,
        source: 'dialpad-extension-calls',
        rfUserId: user.rfUserId,
        dialpadUserId: user.dialpadId,
        callId: eventCallId,
      });
    }

    const result = await stub.clearCallIdIfMatch(eventCallId);
    if (result.cleared) {
      return {
        processed: true,
        reason: 'cleared-on-hangup',
        targetId,
        dialpadUserId: user.dialpadId,
        callId: eventCallId,
        dailyCount,
      };
    }
    return {
      processed: false,
      reason: result.reason === 'mismatch' ? 'callid-mismatch' : 'no-active-record',
      targetId,
      eventCallId,
      recordCallId: result.stored ?? null,
      dailyCount,
    };
  }

  return { processed: false, reason: 'unsupported-state', eventState, eventCallId };
}
