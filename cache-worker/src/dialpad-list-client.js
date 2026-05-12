/**
 * Cache-worker Dialpad call-list client.
 *
 * GET /api/v2/call — every query parameter on the Dialpad spec is optional;
 * the client reflects that. Omit `targetId` / `targetType` to list org-wide
 * (requires a company admin API key per the Dialpad spec, which DIALPAD_API_KEY
 * already is — it's the same value used by the main worker for the call/SMS
 * endpoints). Seed callers leave `startedAfterMs` undefined for the full
 * history; cron callers pass a watermark for incremental fetch.
 *
 * Internal cursor pagination. `maxPages` caps runaway loops (default 25,
 * sized for tail-sync; seed passes a higher cap).
 *
 * Each call's `target.id` carries the per-consultant attribution, so callers
 * never fan out by user — one paginated call covers the whole org.
 *
 * Response items per spec: `{ cursor, items: Call[] }`. Each item has at
 * minimum `call_id`, `target.id`, `contact.id`, `date_started`,
 * `total_duration`, `direction`.
 *
 * @param {object} opts
 * @param {string|number} [opts.targetId]       - filter to a single target id
 * @param {string} [opts.targetType]            - 'user' | 'callcenter' | 'office' | …
 * @param {number} [opts.startedAfterMs]        - UTC ms-since-epoch lower bound (exclusive)
 * @param {number} [opts.startedBeforeMs]       - UTC ms-since-epoch upper bound
 * @param {boolean} [opts.includeAnonymized]    - include deleted-user calls
 * @param {number} [opts.maxPages]              - pagination safety cap (default 25)
 * @param {object} env
 * @returns {Promise<Array>} concatenated `items[]` across all pages
 */
const DEFAULT_MAX_PAGES = 25;

export async function listDialpadCalls(opts, env) {
  if (!env?.DIALPAD_API_KEY) throw new Error('DIALPAD_API_KEY environment variable is required');
  const baseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';
  const o = opts ?? {};
  const maxPages = o.maxPages ?? DEFAULT_MAX_PAGES;

  const items = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const u = new URL(`${baseUrl}/call`);
    if (o.targetId != null) u.searchParams.set('target_id', String(o.targetId));
    if (o.targetType != null) u.searchParams.set('target_type', String(o.targetType));
    if (o.startedAfterMs != null) u.searchParams.set('started_after', String(o.startedAfterMs));
    if (o.startedBeforeMs != null) u.searchParams.set('started_before', String(o.startedBeforeMs));
    if (o.includeAnonymized) u.searchParams.set('include_anonymized', 'true');
    if (cursor) u.searchParams.set('cursor', String(cursor));

    pages++;
    const r = await fetch(u.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${env.DIALPAD_API_KEY}` },
    });
    if (!r.ok) {
      const body = await r.text();
      console.error({
        message: `[dialpad-list] page ${pages} failed status=${r.status}`,
        source: 'dialpad-list-client',
        url: u.toString(),
        status: r.status,
        body: typeof body === 'string' ? body.slice(0, 500) : null,
        page: pages,
      });
      throw new Error(`Dialpad /v2/call failed (HTTP ${r.status}): ${body}`);
    }
    const json = await r.json();
    const pageItems = Array.isArray(json?.items) ? json.items : [];
    items.push(...pageItems);
    cursor = json?.cursor ?? null;

    // Per-page structured log. Workflow contexts have no active span (no global
    // ContextManager outside @microlabs's instrument() wrap), so body-capture
    // can't stamp http.url / http.response.body on Workflow spans — log records
    // are the legibility surface for the inner Dialpad fetch.
    console.log({
      message: `[dialpad-list] page ${pages} status=${r.status} items=${pageItems.length} cumulative=${items.length} cursor=${cursor ? 'y' : 'n'}`,
      source: 'dialpad-list-client',
      url: u.toString(),
      status: r.status,
      item_count: pageItems.length,
      cumulative: items.length,
      has_cursor: !!cursor,
      page: pages,
    });

    if (pages >= maxPages && cursor) {
      console.warn({
        message: `[dialpad-list] hit maxPages=${maxPages} truncating; cursor remaining`,
        source: 'dialpad-list-client', pages, cumulative: items.length,
      });
      break;
    }
    if (!cursor) break;
  }
  return items;
}
