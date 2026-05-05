/**
 * Extension call-state webhook handler.
 *
 * Single responsibility: maintain `extcall:callid:{userId}` in KV based on
 * Dialpad call-state webhook events. The polling endpoint reads that key to
 * tell the extension whether to show Hangup or Call.
 *
 * State transitions are webhook-driven, NOT request-driven:
 *   - `calling` event for a monitored user → KV[user.dialpadId] = call_id
 *     (overwrite-on-write, intentionally — a new call replaces any prior).
 *   - `hangup` event whose call_id matches what's stored → KV.delete
 *     (no-op if call_id doesn't match; protects against stale-event races).
 *   - Anything else (`connected`, `voicemail`, inbound direction, etc.) → drop.
 *
 * No phone-number / external_number matching, no eventual-consistency hooks
 * from /dialpad-call or /dialpad-hangup. Only the webhook touches KV. This
 * makes the system robust against missed events at the cost of "the extension
 * UI lags reality by the webhook delivery delay" — accepted as a nice-to-have
 * UX feature, not a correctness requirement.
 */

import { getUserByDialpadId } from './users.js';

const ACTIVE_TRIGGER_STATES = new Set(['calling']);
const TERMINAL_STATES = new Set(['hangup']);
const EXTCALL_TTL_SEC = 20 * 60;

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

  const user = getUserByDialpadId(targetId);
  if (!user) {
    return { processed: false, reason: 'unmonitored-target', targetId, eventState, eventCallId };
  }

  const kvKey = `extcall:callid:${user.dialpadId}`;

  if (ACTIVE_TRIGGER_STATES.has(eventState)) {
    await env.SYNC_STATE.put(kvKey, eventCallId, { expirationTtl: EXTCALL_TTL_SEC });
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
    const stored = await env.SYNC_STATE.get(kvKey);
    if (!stored) {
      return { processed: false, reason: 'no-active-record', targetId, eventCallId };
    }
    if (stored !== eventCallId) {
      return { processed: false, reason: 'callid-mismatch', targetId, eventCallId, recordCallId: stored };
    }
    await env.SYNC_STATE.delete(kvKey);
    return {
      processed: true,
      reason: 'cleared-on-hangup',
      targetId,
      dialpadUserId: user.dialpadId,
      callId: eventCallId,
    };
  }

  return { processed: false, reason: 'unsupported-state', eventState, eventCallId };
}
