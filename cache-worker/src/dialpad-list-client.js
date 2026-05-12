/**
 * Cache-worker Dialpad call-list client.
 *
 * Every Dialpad /v2/call query parameter is optional; the client reflects the
 * spec. Omit `targetId` + `targetType` to list org-wide (DIALPAD_API_KEY is
 * already a company admin key — same value the main worker uses). Each call's
 * `target.id` carries per-consultant attribution, so callers never fan out
 * by user — one paginated request covers the whole org.
 *
 * Two entry points:
 *
 * - `listDialpadCallsPage(opts, env)` — single page. Returns `{ items, cursor }`.
 *   Use this when the caller drives pagination externally (Workflow step.do
 *   per page, so each step stays well under the 10-min step.do timeout and
 *   the cursor checkpoints between steps).
 *
 * - `listDialpadCalls(opts, env)` — internal cursor loop, capped at
 *   `opts.maxPages` (default 25). Use this for short, bounded reads (e.g.
 *   cron tail-sync over a small recency window) where a single Worker
 *   isolate has time to drain to the end.
 *
 * Per-page structured `console.log` captures URL + status + item count.
 * Workflow contexts have no global ContextManager outside @microlabs's
 * instrument() wrap, so body-capture can't stamp http.url / http.response.body
 * on Workflow spans — log records are the legibility surface for the inner
 * Dialpad fetch.
 */
const DEFAULT_MAX_PAGES = 25;

/**
 * @param {object} opts
 * @param {string|number} [opts.targetId]
 * @param {string} [opts.targetType]
 * @param {number} [opts.startedAfterMs]
 * @param {number} [opts.startedBeforeMs]
 * @param {boolean} [opts.includeAnonymized]
 * @param {string} [opts.cursor]                — pass through from a previous page
 * @param {object} env
 * @returns {Promise<{items: Array, cursor: string|null}>}
 */
export async function listDialpadCallsPage(opts, env) {
  if (!env?.DIALPAD_API_KEY) throw new Error('DIALPAD_API_KEY environment variable is required');
  const baseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';
  const o = opts ?? {};

  const u = new URL(`${baseUrl}/call`);
  if (o.targetId != null) u.searchParams.set('target_id', String(o.targetId));
  if (o.targetType != null) u.searchParams.set('target_type', String(o.targetType));
  if (o.startedAfterMs != null) u.searchParams.set('started_after', String(o.startedAfterMs));
  if (o.startedBeforeMs != null) u.searchParams.set('started_before', String(o.startedBeforeMs));
  if (o.includeAnonymized) u.searchParams.set('include_anonymized', 'true');
  if (o.cursor) u.searchParams.set('cursor', String(o.cursor));

  const r = await fetch(u.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${env.DIALPAD_API_KEY}` },
  });
  if (!r.ok) {
    const body = await r.text();
    console.error({
      message: `[dialpad-list] page failed status=${r.status}`,
      source: 'dialpad-list-client',
      url: u.toString(),
      status: r.status,
      body: typeof body === 'string' ? body.slice(0, 500) : null,
    });
    throw new Error(`Dialpad /v2/call failed (HTTP ${r.status}): ${body}`);
  }
  const json = await r.json();
  const items = Array.isArray(json?.items) ? json.items : [];
  const cursor = json?.cursor ?? null;

  console.log({
    message: `[dialpad-list] page status=${r.status} items=${items.length} cursor=${cursor ? 'y' : 'n'}`,
    source: 'dialpad-list-client',
    url: u.toString(),
    status: r.status,
    item_count: items.length,
    has_cursor: !!cursor,
  });
  return { items, cursor };
}

/**
 * @param {object} opts                — see listDialpadCallsPage; plus:
 * @param {number} [opts.maxPages]     — pagination safety cap (default 25)
 * @param {object} env
 * @returns {Promise<Array>} concatenated `items[]` across all pages
 */
export async function listDialpadCalls(opts, env) {
  const o = opts ?? {};
  const maxPages = o.maxPages ?? DEFAULT_MAX_PAGES;
  const items = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const r = await listDialpadCallsPage({ ...o, cursor }, env);
    items.push(...r.items);
    cursor = r.cursor;
    pages++;
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
