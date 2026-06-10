/**
 * RF client surface for the stage-stats plane: the transactional
 * stage-movement fetch, the candidate/search window walk, and RF timestamp
 * parsing.
 *
 * Two load-bearing RF quirks live here (each cost a debugging session the
 * first time they were hit, on the dashboard side):
 *
 *  1. `after`/`before` MUST be seconds-precision ISO-8601
 *     (`2026-06-08T00:00:00Z`). A sub-second timestamp makes RF 400 every
 *     call — `formatRFSeconds` truncates milliseconds.
 *  2. RF's `entered` timestamps use `+0000` (no colon in the offset).
 *     `parseRFTimestamp` accepts `+0000`, `+00:00`, `Z`, and a
 *     fractional-seconds variant. The VERBATIM string is kept alongside the
 *     parsed ms — it is the dedup identity (`entered_raw`); never normalise it.
 */

import { classifyRFResponse, RFRateLimitedError, RFTransientError } from '../rf-client.js';

/** Bounded backoff for RF bursts: attempt, ~0.4s, attempt, ~1.6s, attempt. */
const RETRY_DELAYS_MS = [400, 1600];

const SOURCE = 'stage-stats';

/**
 * UTC epoch ms → seconds-precision ISO-8601 (`2026-06-08T00:00:00Z`).
 * RF's stage-movement endpoint 400s on sub-second timestamps.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatRFSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const RF_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse an RF timestamp string to UTC epoch ms. Accepts `%Y-%m-%dT%H:%M:%S%z`
 * with `+0000` (RF's usual shape), `+00:00`, bare `Z`, and an optional
 * fractional-seconds component. Returns null for anything else — callers keep
 * the verbatim string regardless (it is the identity; the parse is only for
 * window math).
 *
 * @param {string|null|undefined} s
 * @returns {number|null}
 */
export function parseRFTimestamp(s) {
  if (typeof s !== 'string') return null;
  const m = RF_TS_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac, off] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (frac) ms += Math.round(parseFloat(`0.${frac}`) * 1000);
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const offsetMin = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2), 10));
    ms -= offsetMin * 60_000;
  }
  return ms;
}

/**
 * Send one RF request with the bounded burst backoff: 3 attempts total,
 * retrying on 429 (RFRateLimitedError), 5xx (RFTransientError), and network
 * throws, with jittered 0.4s → 1.6s delays. Bulk stage-moves in RF fan out as
 * many near-simultaneous webhook invocations each fetching from RF — the
 * backoff absorbs the burst limit; anything that still fails is healed by the
 * hourly reconcile.
 *
 * @param {() => Promise<Response>} doFetch - invoked fresh each attempt
 * @param {string} what - request description for logs/errors
 * @returns {Promise<any>} parsed JSON body
 */
async function rfRequestWithRetry(doFetch, what) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    if (attempt > 0) {
      const jitter = Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1] + jitter));
    }
    let response;
    try {
      response = await doFetch();
    } catch (err) {
      lastError = err; // network-level throw — retryable
      continue;
    }
    if (response.ok) {
      return await response.json();
    }
    const body = await response.text().catch(() => null);
    const error = classifyRFResponse(response, body);
    if (error instanceof RFRateLimitedError || error instanceof RFTransientError) {
      lastError = error;
      continue;
    }
    throw error; // hard 4xx — retrying won't help
  }
  console.warn({
    message: `[stage-stats] RF request exhausted retries: ${what}: ${lastError?.message}`,
    source: SOURCE,
    what,
    error: lastError?.message,
  });
  throw lastError;
}

/**
 * Fetch one candidate's stage transitions in `[afterMs, beforeMs)` from RF's
 * TRANSACTIONAL stage-movement store (instantly consistent, carries the
 * mover — unlike the lagging search index).
 *
 * @param {*} env
 * @param {number} candidateId
 * @param {number} afterMs
 * @param {number} beforeMs
 * @returns {Promise<Array<{jobId: number, fromStage: string|null, toStage: string|null,
 *                          enteredRaw: string|null, enteredMs: number|null, moverRfId: number|null}>>}
 */
export async function fetchStageMovements(env, candidateId, afterMs, beforeMs) {
  const base = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
  const params = new URLSearchParams({
    id: String(candidateId),
    after: formatRFSeconds(afterMs),
    before: formatRFSeconds(beforeMs),
  });
  const url = `${base}/candidate/activities/stage-movement/list?${params}`;
  const data = await rfRequestWithRetry(
    () => fetch(url, { headers: { 'RF-Api-Key': env.RF_API_KEY } }),
    `stage-movement candidate ${candidateId}`,
  );

  const out = [];
  const jobs = data?.data?.jobs ?? [];
  for (const job of jobs) {
    const jobId = toInt(job?.id) ?? 0;
    for (const tr of job?.transitions ?? []) {
      const enteredRaw = typeof tr?.entered === 'string' ? tr.entered : null;
      out.push({
        jobId,
        fromStage: typeof tr?.from === 'string' ? tr.from : null,
        toStage: typeof tr?.to === 'string' ? tr.to : null,
        enteredRaw,
        enteredMs: parseRFTimestamp(enteredRaw),
        moverRfId: toInt(tr?.stage_moved_by?.id),
      });
    }
  }
  return out;
}

/**
 * Paginated `POST candidate/search` filtered to `last_activity after
 * <sinceDate>` (absolute, DAY-granular — callers floor a day below their
 * window start). This is the same lagging search index the webhook path
 * escapes — fine here: reconcile/backfill are backstops measured in hours.
 *
 * @param {*} env
 * @param {string} sinceDate - `YYYY-MM-DD` (Europe/London local date)
 * @returns {Promise<Array<{id: number, jobs: Array<{stageName: string|null, prevStageName: string|null}>}>>}
 */
export async function searchActiveCandidates(env, sinceDate) {
  const base = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
  const url = `${base}/candidate/search`;
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const body = {
      items_per_page: 100,
      current_page: page,
      conjunction: 'match-all',
      include_count: true,
      filters: [
        { key: 'last_activity', is_relative: false, filter_type: 'after', date: sinceDate },
      ],
    };
    const data = await rfRequestWithRetry(
      () =>
        fetch(url, {
          method: 'POST',
          headers: { 'RF-Api-Key': env.RF_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      `candidate/search page ${page}`,
    );
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = toInt(row?.id);
      if (id === null) continue;
      const jobs = Array.isArray(row?.jobs)
        ? row.jobs.map((j) => ({
            stageName: typeof j?.stage_name === 'string' ? j.stage_name : null,
            prevStageName:
              typeof j?.previous_stage_details?.prev_stage_name === 'string'
                ? j.previous_stage_details.prev_stage_name
                : null,
          }))
        : [];
      out.push({ id, jobs });
    }
    if (rows.length < 100) break;
    if (page === 50) {
      console.warn({
        message: '[stage-stats] candidate/search exceeded 50 pages — stopping defensively',
        source: SOURCE,
      });
    }
  }
  return out;
}

/** Number | numeric string → integer; anything else → null. */
function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}
