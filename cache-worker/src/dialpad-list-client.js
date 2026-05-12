/**
 * Cache-worker side of Dialpad call listing.
 *
 * Wraps GET /api/v2/call?target_id=…&target_type=user&started_after=… with
 * cursor pagination, capped at MAX_PAGES = 25 (a 15-min cron tick should never
 * need more than 1–3 pages; 25 is the runaway-protection ceiling).
 *
 * Per spec rev 5 DP-1 verification: started_after is UTC ms-since-epoch (int64),
 * strict GT (DP-2), rate limit 1200/min, only includes concluded calls.
 */
const MAX_PAGES = 25;

export async function fetchCallsForConsultant(env, dialpadId, startedAfterMs) {
  if (!env?.DIALPAD_API_KEY) throw new Error('DIALPAD_API_KEY environment variable is required');
  const baseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  const items = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const u = new URL(`${baseUrl}/call`);
    u.searchParams.set('target_id', String(dialpadId));
    u.searchParams.set('target_type', 'user');
    u.searchParams.set('started_after', String(startedAfterMs));
    if (cursor) u.searchParams.set('cursor', String(cursor));
    const r = await fetch(u.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${env.DIALPAD_API_KEY}` },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Dialpad /v2/call failed (HTTP ${r.status}): ${body}`);
    }
    const json = await r.json();
    if (Array.isArray(json?.items)) items.push(...json.items);
    cursor = json?.cursor ?? null;
    pages++;
    if (pages >= MAX_PAGES && cursor) {
      console.warn({
        message: `[dialpad-list] hit MAX_PAGES=${MAX_PAGES} truncating; cursor remaining`,
        source: 'dialpad-list-client', targetId: String(dialpadId), pages,
      });
      break;
    }
    if (!cursor) break;
  }
  return items;
}
