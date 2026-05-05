/**
 * Extension call-state helpers — used by the Call/Hangup button polling flow.
 *
 * Two exports:
 *
 *   findCallForBind(items, { phoneNumber })
 *     Pure helper used by /extension-call-status's discovery branch. Walks
 *     Dialpad's call-list response in order (Dialpad returns most-recent
 *     first) and returns the first item that matches our extension-initiated
 *     outbound call: outbound direction, matching external_number, and an
 *     in-progress state ("calling" or "connected"). Null on no match.
 *
 *   processExtensionCallEvent(payload, env)
 *     Webhook handler for terminal Dialpad call-state events on the
 *     extension subscription (hangup-only, configured Dialpad-side). Reads
 *     the user's KV state record, match-guards against the cached call_id,
 *     and on match flips state to "ended" (preserves callId so /dialpad-
 *     hangup's already-ended fast path can fire). On mismatch / no-record /
 *     no-callId-yet, drops the event silently.
 */

import { getUserByDialpadId } from './users.js';

const IN_PROGRESS_STATES = new Set(['calling', 'connected']);
const TERMINAL_STATES = new Set(['hangup']);
const EXTCALL_TTL_SEC = 20 * 60;

/**
 * Find the first Dialpad call-list item that matches our outbound-initiated
 * call to `phoneNumber`. Returns null if no match.
 */
export function findCallForBind(items, { phoneNumber }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  for (const item of items) {
    if (!item) continue;
    if (item.direction !== 'outbound') continue;
    if (item.external_number !== phoneNumber) continue;
    if (!IN_PROGRESS_STATES.has(item.state)) continue;
    return item;
  }
  return null;
}

/**
 * Webhook handler for Dialpad extension-call hangup events. Returns a small
 * { processed, reason, ... } object so the route can log a single structured
 * line per event.
 */
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
  if (!TERMINAL_STATES.has(eventState)) {
    return { processed: false, reason: 'not-terminal', eventState, eventCallId };
  }

  const user = getUserByDialpadId(targetId);
  if (!user) {
    return { processed: false, reason: 'unmonitored-target', targetId, eventState, eventCallId };
  }

  const kvKey = `extcall:state:${user.dialpadId}`;
  const raw = await env.SYNC_STATE.get(kvKey);
  if (!raw) {
    return { processed: false, reason: 'no-record', targetId, eventCallId };
  }

  let record;
  try { record = JSON.parse(raw); }
  catch { return { processed: false, reason: 'malformed-record', targetId, eventCallId }; }

  if (!record?.callId) {
    return { processed: false, reason: 'no-callid-bound', targetId, eventCallId };
  }
  if (String(record.callId) !== eventCallId) {
    return { processed: false, reason: 'callid-mismatch', targetId, eventCallId, recordCallId: record.callId };
  }

  await env.SYNC_STATE.put(
    kvKey,
    JSON.stringify({ ...record, state: 'ended' }),
    { expirationTtl: EXTCALL_TTL_SEC },
  );

  return {
    processed: true,
    reason: 'flipped-to-ended',
    targetId,
    dialpadUserId: user.dialpadId,
    callId: eventCallId,
  };
}
