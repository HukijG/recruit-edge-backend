/**
 * `GET /stats/stage-aggregate?afterMs=&beforeMs=` (auth `X-Stats-Token`) —
 * the pull side of the §4 wire contract. The window is caller-chosen: the
 * dashboard's puller asks for the current week, the last-week toggle for the
 * previous week, ad-hoc audits for anything else.
 */

import { computeAggregate } from './store.js';
import { requireStatsToken } from './stats-token.js';

/**
 * @param {Request} request
 * @param {*} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleAggregatePull(request, env, url) {
  const denied = requireStatsToken(request, env);
  if (denied) return denied;

  const afterMs = Number(url.searchParams.get('afterMs'));
  const beforeMs = Number(url.searchParams.get('beforeMs'));
  if (!Number.isInteger(afterMs) || !Number.isInteger(beforeMs) || afterMs >= beforeMs) {
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
