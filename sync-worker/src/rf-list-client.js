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

async function rfGet(env, path, params = {}) {
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
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`RF GET ${path} ${r.status} ${text}`);
  }
  return r.json();
}

async function rfPost(env, path, body) {
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
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`RF POST ${path} ${r.status} ${text}`);
  }
  return r.json();
}

/**
 * GET /candidate/get?id=...
 * Returns the parsed JSON candidate payload (caller knows the shape).
 */
export async function fetchCandidate(env, id) {
  return rfGet(env, '/candidate/get', { id: String(id) });
}

/**
 * Returns ids of candidates whose `last_updated` is strictly greater than `cursor`
 * (ISO 8601 string). Paginates `/candidate/search` sorted last_updated DESC, breaks
 * when we encounter a row at-or-older-than cursor.
 *
 * Hard cap of 5000 ids — the tail-sync caller batches downstream work and
 * unbounded results would blow the worker's runtime limits if RF ever returned
 * a huge backlog (e.g. an outage recovery). If we hit the cap, the caller will
 * naturally pick up where this left off on the next tick because it advances
 * the cursor only after processing the returned ids.
 *
 * NOTE: the exact filter/sort key for `last_updated` on `/candidate/search` is
 * pending Joel's confirmation before sync ships. Code defensively — even if the
 * sort hint is ignored upstream, the break-when-stale logic still terminates
 * the loop as long as the response eventually drains.
 */
export async function fetchCandidatesUpdatedSince(env, cursor) {
  const ids = [];
  let page = 1;
  const PAGE_SIZE = 100;
  const HARD_CAP = 5000;

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
        if (ids.length >= HARD_CAP) {
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
  return ids;
}

/**
 * Paginated `/job/list`. Returns the flat array of job objects.
 */
export async function fetchAllJobs(env) {
  const jobs = [];
  let page = 1;
  const PAGE_SIZE = 500;
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
export async function fetchCandidateListPage(env, page, pageSize = 500) {
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
  const resp = await rfGet(env, '/user/list', { items_per_page: '500' });
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
