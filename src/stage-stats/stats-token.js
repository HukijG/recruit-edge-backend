/**
 * `X-Stats-Token` gate for the stats pull + admin routes
 * (`GET /stats/stage-aggregate`, `POST /admin/stage-stats/*`).
 *
 * Machine-to-machine routes (the dashboard server / operator curl) — NOT
 * user-facing, so per docs/security.md they use a shared-token header, not
 * Cloudflare Access. Fail closed: no configured secret ⇒ every request 401s.
 */

import { timingSafeEqual } from '../lib/timing-safe-equal.js';

/**
 * Returns a 401 Response to short-circuit with, or null when authorized.
 *
 * @param {Request} request
 * @param {*} env
 * @returns {Response|null}
 */
export function requireStatsToken(request, env) {
  const expected = env.STATS_PULL_TOKEN;
  const presented = request.headers.get('X-Stats-Token');
  if (!expected || !presented || !timingSafeEqual(presented, expected)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
