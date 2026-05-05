/**
 * ExtCallState — Durable Object holding a single user's currently-active
 * Dialpad call_id with strong consistency.
 *
 * Why a DO and not KV: CF Workers KV is eventually consistent across PoPs.
 * A `calling` webhook landing at PoP-A and a polling read at PoP-B can be
 * 1-5 seconds out-of-sync (occasionally more), which produced a visible
 * "no active call → ended" window after the call had already started.
 * DOs route every request to a single instance, giving strict read-after-
 * write semantics regardless of which PoP the request originates from.
 *
 * One DO instance per Dialpad user, keyed by `idFromName(dialpadUserId)`.
 * Storage holds at most a single record: `{ callId: string }`.
 *
 * RPC surface:
 *   - setCallId(callId)        → writes (overwrites prior). Schedules a
 *                                20-min alarm so abandoned records auto-
 *                                clean.
 *   - getCallId()              → returns the stored call_id or null.
 *   - clearCallIdIfMatch(id)   → clears iff stored call_id matches `id`.
 *                                Drop-and-log otherwise. Used by the
 *                                hangup webhook to avoid wiping a newer
 *                                call when a stale event arrives.
 *
 * The `/dialpad-hangup` endpoint reads via getCallId() and never writes —
 * the hangup webhook is the only path that clears (matching the
 * single-writer invariant from the KV design).
 */

import { DurableObject } from 'cloudflare:workers';

const TTL_MS = 20 * 60 * 1000;
const STORAGE_KEY = 'callId';

export class ExtCallState extends DurableObject {
  async setCallId(callId) {
    const value = String(callId);
    await this.ctx.storage.put(STORAGE_KEY, value);
    // 20-min self-cleanup. If a new setCallId lands before the alarm fires,
    // it just resets the alarm (setAlarm overwrites any pending one).
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
    return { ok: true, callId: value };
  }

  async getCallId() {
    const stored = await this.ctx.storage.get(STORAGE_KEY);
    return stored ?? null;
  }

  async clearCallIdIfMatch(callId) {
    const want = String(callId);
    const stored = await this.ctx.storage.get(STORAGE_KEY);
    if (!stored) {
      return { cleared: false, reason: 'no-record' };
    }
    if (String(stored) !== want) {
      return { cleared: false, reason: 'mismatch', stored };
    }
    await this.ctx.storage.delete(STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
    return { cleared: true };
  }

  async alarm() {
    // 20 minutes have elapsed since the last setCallId. If anything is
    // still here, it's a stranded record (probably because Dialpad never
    // delivered the matching hangup webhook). Clear it so the user's next
    // call starts from a clean slate.
    await this.ctx.storage.delete(STORAGE_KEY);
  }
}
