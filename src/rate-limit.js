/**
 * Per-user rate limiting + cheap dedup for /dialpad-call.
 *
 * Dialpad caps each user at 5 outbound calls/minute. We mirror that limit on
 * our side so the extension gets a clean 429 instead of a silently-rejected
 * Dialpad call when a recruiter pounds the call button. Same KV entry also
 * powers a 3-second per-(user, phone) dedup window — defence-in-depth against
 * literal double-clicks.
 *
 * Storage: SYNC_STATE key `ratelimit:call:{dialpadUserId}` →
 *   JSON `[{ t: <ms epoch>, phone: "+..." }, ...]` (most-recent-first not
 *   guaranteed; readers must filter by `t`). 120s TTL is enough to outlive
 *   the rolling window and self-cleans without a separate sweeper.
 *
 * The pure decision function is exported separately so it can be unit-tested
 * without touching KV. The KV wrapper is the only thing the route should call.
 */

export const CALL_RATE_LIMIT = 5;
export const CALL_RATE_WINDOW_MS = 60_000;
export const CALL_DEDUP_WINDOW_MS = 3_000;
const KV_TTL_SECONDS = 120;

/**
 * Pure rate-limit + dedup decision.
 *
 * Returns `{ allowed: true, nextTimestamps }` when the call should proceed —
 * the caller persists `nextTimestamps`. Returns `{ allowed: false, reason,
 * retryAfterSec }` when blocked — the caller surfaces a 429 and does NOT
 * persist anything (denied attempts must not consume future budget).
 *
 * Dedup verdict takes precedence over rate-limit when both fire on the same
 * request — it produces a more actionable error message ("you literally just
 * called this number") than the generic rate-limit cap.
 *
 * @param {Object} params
 * @param {Array<{t:number, phone:string}>} params.timestamps - prior recorded calls
 * @param {number} params.now - current ms-epoch
 * @param {string} params.phoneNumber - destination phone for the request
 */
export function decideCallRateLimit({ timestamps, now, phoneNumber }) {
  const windowStart = now - CALL_RATE_WINDOW_MS;
  const dedupCutoff = now - CALL_DEDUP_WINDOW_MS;

  // Drop expired entries — those don't count toward either check, and we
  // don't want them growing the JSON unboundedly when we write back.
  const recent = (Array.isArray(timestamps) ? timestamps : [])
    .filter(e => e && typeof e.t === 'number' && e.t > windowStart);

  // Dedup check first — same phone within last 3s.
  const dup = recent.find(e => e.phone === phoneNumber && e.t > dedupCutoff);
  if (dup) {
    const retryAfterSec = Math.max(1, Math.ceil((dup.t + CALL_DEDUP_WINDOW_MS - now) / 1000));
    return { allowed: false, reason: 'duplicate', retryAfterSec };
  }

  // Rate-limit check.
  if (recent.length >= CALL_RATE_LIMIT) {
    // Sort ascending so we can find the oldest in-window timestamp.
    const oldest = recent.reduce((a, b) => (a.t < b.t ? a : b)).t;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + CALL_RATE_WINDOW_MS - now) / 1000));
    return { allowed: false, reason: 'rate_limit', retryAfterSec };
  }

  return {
    allowed: true,
    nextTimestamps: [...recent, { t: now, phone: phoneNumber }],
  };
}

/**
 * KV-backed wrapper: read prior state for the user, decide, write back if
 * allowed. The read-decide-write isn't transactional — two concurrent
 * requests from the same edge can both pass through. That's acceptable here
 * (the worst case is one extra call slipping past the cap, which Dialpad
 * itself would still reject anyway).
 */
export async function checkAndRecordCall({ dialpadUserId, phoneNumber, now = Date.now() }, env) {
  const key = `ratelimit:call:${dialpadUserId}`;
  const raw = await env.SYNC_STATE.get(key);
  let timestamps = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) timestamps = parsed;
    } catch {
      // Corrupt entry — treat as empty and overwrite below.
    }
  }

  const decision = decideCallRateLimit({ timestamps, now, phoneNumber });

  if (decision.allowed) {
    await env.SYNC_STATE.put(key, JSON.stringify(decision.nextTimestamps), {
      expirationTtl: KV_TTL_SECONDS,
    });
  }

  return decision;
}
