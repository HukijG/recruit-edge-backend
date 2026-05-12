/**
 * Forward a Dialpad hangup webhook payload to cache-worker for calls-cache
 * insertion. Failures are logged but never thrown — drop-and-rely-on-cron-
 * backfill is the chosen design (per spec rev 5 "drop after one attempt,
 * rely on cron").
 *
 * Cache-worker's /internal/calls/upsert is gated by X-Internal-Token (per
 * spec rev 5 "Auth: Two-layer" — workers_dev=false + shared secret).
 */
export async function forwardHangupToSyncWorker(payload, env) {
  if (!env.SYNC_WORKER?.fetch) {
    console.warn({ message: '[hangup-forwarder] SYNC_WORKER binding missing — skipping', source: 'hangup-forwarder' });
    return;
  }
  if (!env.INTERNAL_SECRET) {
    console.warn({ message: '[hangup-forwarder] INTERNAL_SECRET not set — skipping forward', source: 'hangup-forwarder', callId: payload?.call_id });
    return;
  }
  try {
    const res = await env.SYNC_WORKER.fetch('http://internal/internal/calls/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': env.INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Defensive PII hardening: cap the logged body at 200 chars. Today's
      // cache-worker error envelopes (`{ok:false, error:'auth'|'invalid json'|...}`)
      // don't echo request fields, but if a future change interpolates
      // `payload.contact?.id` or `payload.call_id` into an error string, the
      // cap limits the blast radius. The INTERNAL_SECRET value is never
      // substituted into any log payload.
      const rawBody = await res.text();
      const body = typeof rawBody === 'string' ? rawBody.slice(0, 200) : null;
      console.warn({
        message: `[hangup-forwarder] cache-worker rejected upsert status=${res.status}`,
        source: 'hangup-forwarder',
        callId: payload?.call_id,
        status: res.status,
        body,
      });
    }
    // 2xx success: deliberately log nothing. Success is the expected path; no
    // diagnostic value in echoing the response body, and avoiding the body
    // log removes any chance of incidental data leakage if the cache-worker
    // success envelope ever changes.
  } catch (err) {
    console.warn({
      message: `[hangup-forwarder] forward failed: ${err.message}`,
      source: 'hangup-forwarder',
      callId: payload?.call_id,
    });
  }
}
