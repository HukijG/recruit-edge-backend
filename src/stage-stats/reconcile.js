/**
 * Reconcile — the backstop for missed/failed webhooks (worker down, RF
 * outage, 500s RF never retried, rate-limit residue).
 *
 * The window reaches back to the PREVIOUS week's Monday (Europe/London) so
 * the last-week aggregate keeps healing across the weekly boundary — a move
 * missed Sunday 23:50 is still swept on Monday, which is what the dashboard's
 * LAST-WEEK toggle reads. Gated (reached-submission) to bound RF detail
 * calls; the gate's residual hole is recoverable via an ungated backfill.
 *
 * Runs hourly from cron (`7 * * * *` → src/index.js `scheduled()`) and on
 * demand via `POST /admin/stage-stats/reconcile`.
 */

import { previousWeekStartLondon } from './week.js';
import { ingestWindow } from './ingest.js';
import { recomputeAndPush } from './push.js';
import { requireStatsToken } from './stats-token.js';

const SOURCE = 'stage-stats';

/**
 * One reconcile sweep: ingest the prev-Monday → now window (gated), then push
 * unconditionally — the push is cheap and idempotent; no changed-detection
 * bookkeeping.
 *
 * @param {*} env
 * @returns {Promise<{candidates: number, gated: number, fetched: number, stored: number, failed: number}>}
 */
export async function runReconcile(env) {
  const now = Date.now();
  const stats = await ingestWindow(env, {
    afterMs: previousWeekStartLondon(now),
    beforeMs: now,
    gate: true,
    source: 'reconcile',
  });
  console.log({
    message: `[stage-stats] reconcile: candidates=${stats.candidates} gated=${stats.gated} stored=${stats.stored} failed=${stats.failed}`,
    source: SOURCE,
    candidates: stats.candidates,
    gated: stats.gated,
    stored: stats.stored,
    failed: stats.failed,
  });
  await recomputeAndPush(env);
  return stats;
}

/**
 * `POST /admin/stage-stats/reconcile` (auth `X-Stats-Token`) — the same sweep
 * on demand, for ops and for testing without waiting for the hour.
 *
 * @param {Request} request
 * @param {*} env
 * @returns {Promise<Response>}
 */
export async function handleReconcileRoute(request, env) {
  const denied = requireStatsToken(request, env);
  if (denied) return denied;
  try {
    const stats = await runReconcile(env);
    return Response.json({ ok: true, ...stats });
  } catch (err) {
    console.error({
      message: `[stage-stats] manual reconcile failed: ${err?.message}`,
      source: SOURCE,
      error: err?.message,
    });
    return Response.json({ ok: false, error: err?.message ?? 'reconcile failed' }, { status: 500 });
  }
}
