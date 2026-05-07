/**
 * RecruiterFlow read-only list client (sync-worker side).
 *
 * Pure-fetch wrapper around the small set of RF endpoints the tail-sync and
 * rebuild paths need. No caching, no retries, no SDK — that lives in the main
 * worker's `src/rf-client.js`. All functions take `env` first to match the
 * `sync-state.js` style.
 *
 * NOTE: the RF base URL falls back to the public default if `env.RF_API_BASE_URL`
 * is unset. Tests set both explicitly.
 */

const DEFAULT_BASE_URL = 'https://api.recruiterflow.com/api/external';

function baseUrl(env) {
  return env.RF_API_BASE_URL || DEFAULT_BASE_URL;
}

async function rfGet(env, path, params = {}, attempt = 0) {
  if (!env.RF_API_KEY) {
    throw new Error('RF_API_KEY environment variable is required');
  }
  const url = new URL(baseUrl(env) + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'RF-Api-Key': env.RF_API_KEY,
      'Content-Type': 'application/json',
    },
  });
  // RF's edge produces transient 502s on read paths; one retry is far cheaper
  // than failing the caller. Mirror `getRFCandidate` in the main worker.
  if (r.status === 502 && attempt === 0) {
    console.warn(`[rf] 502 on GET ${path}, retrying once`);
    return rfGet(env, path, params, 1);
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`RF GET ${path} ${r.status} ${text}`);
  }
  return r.json();
}

async function rfPost(env, path, body, attempt = 0) {
  if (!env.RF_API_KEY) {
    throw new Error('RF_API_KEY environment variable is required');
  }
  const r = await fetch(baseUrl(env) + path, {
    method: 'POST',
    headers: {
      'RF-Api-Key': env.RF_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  // Same one-shot 502 retry as rfGet — RF's edge occasionally bounces these
  // and the search/list reads here are idempotent so retry is safe.
  if (r.status === 502 && attempt === 0) {
    console.warn(`[rf] 502 on POST ${path}, retrying once`);
    return rfPost(env, path, body, 1);
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`RF POST ${path} ${r.status} ${text}`);
  }
  return r.json();
}

/**
 * GET /candidate/get?id=...
 * Returns the parsed JSON candidate payload. RF sometimes wraps the candidate
 * in `{ candidate: {...} }` (matching main worker's getRFCandidate behaviour);
 * unwrap if present so downstream code sees a uniform shape.
 */
export async function fetchCandidate(env, id) {
  const result = await rfGet(env, '/candidate/get', { id: String(id) });
  return result?.candidate ?? result;
}

/**
 * Returns ids of candidates whose `last_updated` is strictly greater than `cursor`
 * (ISO 8601 string), plus a `suggestedCursor` the caller should advance to after
 * processing. Paginates `/candidate/search` sorted last_updated DESC, breaks
 * when we encounter a row at-or-older-than cursor.
 *
 * Hard cap of 5000 ids — the tail-sync caller batches downstream work and
 * unbounded results would blow the worker's runtime limits if RF ever returned
 * a huge backlog (e.g. an outage recovery).
 *
 * Why the return shape includes `suggestedCursor`:
 * - We sort DESC because there is no `last_updated >= cursor` filter on RF's
 *   `/candidate/search` (TBD, may never exist) — the only way to do incremental
 *   reads is "newest first, break when we hit cursor".
 * - DESC + cap means if 5001+ rows are fresh, we return the 5000 NEWEST and
 *   skip 1+ older-but-still-fresh rows.
 * - If the caller advances `cursor = MAX(returned)` after processing, those
 *   skipped rows have `last_updated < new cursor` and are silently dropped
 *   forever — DATA LOSS.
 * - Fix: when capped, set `suggestedCursor = MIN(returned)` (oldest of the
 *   returned set) so the next tick re-fetches from the cap edge. The newest
 *   rows we already processed will be re-seen — that's idempotent overlap,
 *   acceptable cost. Missed rows are not.
 * - When NOT capped, `suggestedCursor = MAX(returned)` (newest) — we have the
 *   full delta, advance to the watermark.
 * - When no fresh rows, `suggestedCursor = cursor` (no movement).
 *
 * NOTE: the exact sort key for `last_updated` on `/candidate/search` is pending
 * Joel's confirmation before sync ships. Code defensively — even if the sort
 * hint is ignored upstream, the break-when-stale logic still terminates as
 * long as the response eventually drains.
 */
export async function fetchCandidatesUpdatedSince(env, cursor) {
  const ids = [];
  const timestamps = [];
  let page = 1;
  const PAGE_SIZE = 100;
  const HARD_CAP = 5000;
  let capped = false;

  for (;;) {
    const resp = await rfPost(env, '/candidate/search', {
      conjunction: 'match-all',
      filters: [],
      items_per_page: String(PAGE_SIZE),
      current_page: String(page),
      sort: [{ key: 'last_updated', direction: 'desc' }],
    });
    const rows = Array.isArray(resp?.data) ? resp.data : [];
    if (rows.length === 0) break;

    let stopped = false;
    for (const row of rows) {
      if (row.last_updated && row.last_updated > cursor) {
        ids.push(row.id);
        timestamps.push(row.last_updated);
        if (ids.length >= HARD_CAP) {
          capped = true;
          stopped = true;
          break;
        }
      } else {
        stopped = true;
        break;
      }
    }
    if (stopped || rows.length < PAGE_SIZE) break;
    page++;
  }

  let suggestedCursor;
  if (timestamps.length === 0) {
    suggestedCursor = cursor;
  } else if (capped) {
    // Drop the cap edge (oldest of the returned set) on the floor so next
    // tick refetches from there — overlap is fine, missed rows are not.
    suggestedCursor = timestamps.reduce((a, b) => (a < b ? a : b));
  } else {
    suggestedCursor = timestamps.reduce((a, b) => (a > b ? a : b));
  }

  return { ids, suggestedCursor };
}

/**
 * Paginated `/job/list`. Returns the flat array of job objects.
 */
export async function fetchAllJobs(env) {
  const jobs = [];
  let page = 1;
  const PAGE_SIZE = 100;  // RF caps list endpoints at 100/page
  for (;;) {
    const resp = await rfGet(env, '/job/list', {
      items_per_page: String(PAGE_SIZE),
      current_page: String(page),
    });
    const rows = Array.isArray(resp?.data) ? resp.data : [];
    if (rows.length === 0) break;
    jobs.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    page++;
  }
  return jobs;
}

/**
 * Single page of `/candidate/list`. Returns `{ rows, total }`.
 * Caller drives pagination — used by the rebuild path which checkpoints by page.
 */
export async function fetchCandidateListPage(env, page, pageSize = 100) {
  const resp = await rfGet(env, '/candidate/list', {
    items_per_page: String(pageSize),
    current_page: String(page),
  });
  return {
    rows: Array.isArray(resp?.data) ? resp.data : [],
    total: typeof resp?.total === 'number' ? resp.total : null,
  };
}

/**
 * `/user/list` — RF user directory. Returns the array under `data` (or [] if absent).
 */
export async function fetchUsers(env) {
  // RF user list is small (~tens of rows for our team) — one page at the cap.
  const resp = await rfGet(env, '/user/list', { items_per_page: '100' });
  return Array.isArray(resp?.data) ? resp.data : [];
}

/**
 * `/activity-type/list` — RF activity type catalogue.
 */
export async function fetchActivityTypes(env) {
  const resp = await rfGet(env, '/activity-type/list');
  return Array.isArray(resp?.data) ? resp.data : [];
}

/**
 * `/customfield/list` — RF custom field schema across entities.
 */
export async function fetchCustomFieldSchema(env) {
  const resp = await rfGet(env, '/customfield/list');
  return Array.isArray(resp?.data) ? resp.data : [];
}
