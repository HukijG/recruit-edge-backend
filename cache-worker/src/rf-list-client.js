/**
 * RecruiterFlow read-only list client (cache-worker side).
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
 * Returns ids of candidates whose `last_activity` is strictly after `cursor`
 * (ISO 8601 datetime), plus a `suggestedCursor` the caller advances to.
 *
 * RF's /candidate/search supports a date filter on `last_activity` (NOT
 * `last_updated` — that key is rejected). We pass an absolute "after" filter
 * with the cursor's date portion (RF's date filters use day granularity), so
 * the response is guaranteed to contain only rows newer-than-or-equal-to the
 * cursor day. Pagination walks until rows.length < PAGE_SIZE.
 *
 * Hard cap of 5000 ids per tick — defensive against a huge backlog (outage
 * recovery). Capped path returns `suggestedCursor = cursor` so the next tick
 * picks up from the same point (no advancement when we know we left rows on
 * the table). Caller must therefore guarantee idempotent upserts (it does:
 * INSERT OR REPLACE on candidates + DELETE+INSERT on candidate_jobs).
 */
export async function fetchCandidatesUpdatedSince(env, cursor) {
  const ids = [];
  let page = 1;
  const PAGE_SIZE = 100;
  const HARD_CAP = 5000;
  let capped = false;

  // RF date filters use day granularity (YYYY-MM-DD). Round the cursor down
  // to its date and let the per-row last_activity_at do the precise filtering
  // (cheap idempotent overlap on the boundary day).
  const cursorDate = (cursor || '').slice(0, 10) || '1970-01-01';

  for (;;) {
    const resp = await rfPost(env, '/candidate/search', {
      conjunction: 'match-all',
      filters: [{
        filter_type: 'after',
        is_relative: false,
        date: cursorDate,
        key: 'last_activity',
        type: 'date',
      }],
      items_per_page: String(PAGE_SIZE),
      current_page: String(page),
    });
    const rows = Array.isArray(resp?.data) ? resp.data : (Array.isArray(resp) ? resp : []);
    if (rows.length === 0) break;
    for (const row of rows) {
      ids.push(row.id);
      if (ids.length >= HARD_CAP) { capped = true; break; }
    }
    if (capped || rows.length < PAGE_SIZE) break;
    page++;
  }

  // Cursor advancement:
  //  - not capped → set to "now" (we got the full delta from RF's filter).
  //  - capped → leave cursor unchanged so next tick repeats from same boundary.
  //    (Idempotent upserts make repeat-processing free apart from RF round trips.)
  const suggestedCursor = capped ? cursor : new Date().toISOString();
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
    // RF returns a bare JSON array; handle envelope form too.
    const rows = Array.isArray(resp) ? resp
      : Array.isArray(resp?.data) ? resp.data : [];
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
  // RF returns a bare JSON array for /candidate/list (and /job/list).
  // Older envelope shape was { data: [...] } — handle both defensively.
  const rows = Array.isArray(resp) ? resp
    : Array.isArray(resp?.data) ? resp.data : [];
  return {
    rows,
    total: typeof resp?.total === 'number' ? resp.total : null,
  };
}

/**
 * `/user/list` — RF user directory. Returns the array under `data` (or [] if absent).
 */
export async function fetchUsers(env) {
  // RF user list is small (~tens of rows for our team) — one page at the cap.
  const resp = await rfGet(env, '/user/list', { items_per_page: '100' });
  if (Array.isArray(resp)) return resp;
  return Array.isArray(resp?.data) ? resp.data : [];
}

/**
 * `/activity-type/list` — RF activity type catalogue.
 * Returns [] on 404 (the path may not exist in RF; reference data is best-effort).
 */
export async function fetchActivityTypes(env) {
  try {
    const resp = await rfGet(env, '/activity-type/list');
    return Array.isArray(resp?.data) ? resp.data : [];
  } catch (err) {
    if (/\b404\b/.test(err.message)) {
      console.warn('[rf] /activity-type/list returned 404; skipping');
      return [];
    }
    throw err;
  }
}

/**
 * `/customfield/list` — RF custom field schema across entities.
 * Returns [] on 404 (best-effort like activity types).
 */
export async function fetchCustomFieldSchema(env) {
  try {
    const resp = await rfGet(env, '/customfield/list');
    return Array.isArray(resp?.data) ? resp.data : [];
  } catch (err) {
    if (/\b404\b/.test(err.message)) {
      console.warn('[rf] /customfield/list returned 404; skipping');
      return [];
    }
    throw err;
  }
}

/**
 * GET /job/pipeline?job_id=…
 * RF returns { summary: [{id, name, count}, …], detail: [{candidate, stages: []}, …] }.
 * `summary[]` is the canonical, ordered pipeline (includes 0-count stages and
 * Disqualified). `detail[]` carries each candidate's full stage movement
 * history — the most recent `stages[].time` `to` is their current stage.
 *
 * No pagination at this scale (largest job's detail[] is ~few hundred).
 */
export async function fetchJobPipeline(env, jobId) {
  return rfGet(env, '/job/pipeline', { job_id: String(jobId) });
}

/**
 * Returns candidate ROWS (full RF /candidate/search response items) whose
 * `added_time` is on or after `cursor` (an ISO 8601 datetime).
 *
 * Uses RF's `/candidate/search` with the `added_on` date filter — we don't use
 * `/candidate/list` because RF doesn't expose a cursor on it (spec rev 5 RF-2
 * verified: `/candidate/list` is offset-only, no `since_id`, no documented
 * sort order). The `added_on` filter system field is documented in the rev-5
 * RF-7 verification.
 *
 * Cursor advancement (per spec rev 5):
 *   - Not capped → set to MAX(added_time) seen across all rows.
 *   - Capped → set to MIN(added_time) seen, never moving backward of input.
 *     (Ensures forward progress on huge multi-day backlogs while accepting
 *     same-day overlap, which is idempotent via INSERT-OR-IGNORE on PK.)
 *
 * Hard cap of 5000 rows per tick (defensive — outage recovery).
 *
 * Known edge case: if more than 5000 candidates are added on the SAME day AND
 * some have `added_time` earlier than the input cursor (i.e., cursor advanced
 * past noon, batch MIN is at 09:00), the never-backward guard pins the cursor
 * at the input and the next tick re-fetches the same boundary day. INSERT-OR-
 * IGNORE absorbs the dupes (no data corruption), but no forward progress is
 * made until the boundary day clears. Far outside the operating envelope
 * (typical ≤10 new candidates/tick per spec rev 5 line 333); only reachable
 * on an unprecedented single-day spike during outage recovery.
 */
export async function fetchCandidatesAddedSince(env, cursor) {
  const rows = [];
  let page = 1;
  const PAGE_SIZE = 100;
  const HARD_CAP = 5000;
  let capped = false;

  const cursorMs = Date.parse(cursor);
  const cursorDate = (cursor || '').slice(0, 10) || '1970-01-01';

  for (;;) {
    const resp = await rfPost(env, '/candidate/search', {
      conjunction: 'match-all',
      filters: [{
        type: 'date',
        is_relative: false,
        filter_type: 'after',
        date: cursorDate,
        key: 'added_on',
      }],
      items_per_page: String(PAGE_SIZE),
      current_page: String(page),
    });
    const batch = Array.isArray(resp?.data) ? resp.data : (Array.isArray(resp) ? resp : []);
    if (batch.length === 0) break;
    for (const row of batch) {
      rows.push(row);
      if (rows.length >= HARD_CAP) { capped = true; break; }
    }
    if (capped || batch.length < PAGE_SIZE) break;
    page++;
  }

  let suggestedCursor = cursor;
  if (rows.length > 0) {
    const times = rows.map(r => Date.parse(r.added_time)).filter(n => Number.isFinite(n));
    if (times.length > 0) {
      const candidate = capped ? Math.min(...times) : Math.max(...times);
      // Never move the cursor backward (defensive against day-granularity overlap).
      suggestedCursor = new Date(Math.max(candidate, cursorMs || 0)).toISOString();
    }
  } else if (!capped) {
    // No new rows AND not capped → nothing changed; keep cursor as-is.
    suggestedCursor = cursor;
  }

  return { rows, suggestedCursor, capped };
}
