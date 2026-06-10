/**
 * `GET /stats/stage-aggregate?afterMs=&beforeMs=` (auth `X-Stats-Token`) —
 * the pull side of the §4 wire contract. The window is caller-chosen: the
 * dashboard's puller asks for the current week, the last-week toggle for the
 * previous week, ad-hoc audits for anything else.
 */

import { computeAggregate } from './store.js';
import { requireStatsToken } from './stats-token.js';

/** Decimal-integer string → number; anything else (incl. null/empty) → null. */
function parseEpochMsParam(raw) {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) return null;
  return parseInt(raw, 10);
}

/**
 * @param {Request} request
 * @param {*} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleAggregatePull(request, env, url) {
  const denied = requireStatsToken(request, env);
  if (denied) return denied;

  // Strict parse: a MISSING param must 400 — Number(null) === 0 would
  // silently turn it into "since the epoch" instead.
  const afterMs = parseEpochMsParam(url.searchParams.get('afterMs'));
  const beforeMs = parseEpochMsParam(url.searchParams.get('beforeMs'));
  if (afterMs === null || beforeMs === null || afterMs >= beforeMs) {
    return Response.json(
      { ok: false, error: 'afterMs and beforeMs must be integers with afterMs < beforeMs' },
      { status: 400 },
    );
  }

  const aggregate = await computeAggregate(env, afterMs, beforeMs);
  return Response.json({
    schema: 1,
    windowStartMs: afterMs,
    windowEndMs: beforeMs,
    asOfMs: Date.now(),
    cvSent: aggregate.cvSent,
    firstInterviews: aggregate.firstInterviews,
  });
}
