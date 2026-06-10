/**
 * Aggregate → dashboard push: recompute the current Mon–Sun London week from
 * D1 and POST it to every configured ingress target. Push is the fast path
 * (event → TV in seconds); the dashboard's puller is the seed/heal path —
 * both carry the same payload shape.
 *
 * Fan-out: `DASHBOARD_REMOTE_BASE` (prod — required for the plane to push at
 * all) and `DASHBOARD_REMOTE_BASE_DEV` (optional additional target; unset ⇒
 * single-target). Targets are fully independent — one target's failure never
 * affects the other.
 */

import { currentWeekWindowLondon } from './week.js';
import { computeAggregate } from './store.js';

const SOURCE = 'stage-stats';

/**
 * Recompute the current week's aggregate and push it to all configured
 * targets. Never throws — every failure path is logged and absorbed (the
 * pull path heals).
 *
 * @param {*} env
 * @returns {Promise<void>}
 */
export async function recomputeAndPush(env) {
  if (!env.DASHBOARD_REMOTE_BASE || !env.DASHBOARD_REMOTE_KEY) {
    console.warn({
      message:
        '[stage-stats] push skipped: DASHBOARD_REMOTE_BASE / DASHBOARD_REMOTE_KEY unset — stats are computed but never delivered',
      source: SOURCE,
    });
    return;
  }

  const window = currentWeekWindowLondon(Date.now());
  let aggregate;
  try {
    aggregate = await computeAggregate(env, window.startMs, window.endMs);
  } catch (err) {
    // Honour the never-throws contract — the webhook path runs this inside
    // ctx.waitUntil, where a rejection would be silent. The next push or the
    // dashboard's puller heals.
    console.warn({
      message: `[stage-stats] push skipped: aggregate computation failed (${err?.message})`,
      source: SOURCE,
      error: err?.message,
    });
    return;
  }
  const body = JSON.stringify({
    schema: 1,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    // asOfMs MUST be stamped AFTER the D1 read: the dashboard's monotonic
    // guard orders racing pushes by asOf, so the stamp has to reflect read
    // recency — a pre-read stamp would let an older aggregate beat a newer
    // one whose push started earlier (§4.1: "when the aggregate was computed").
    asOfMs: Date.now(),
    cvSent: aggregate.cvSent,
    firstInterviews: aggregate.firstInterviews,
  });
  const cvTotal = aggregate.cvSent.reduce((n, e) => n + e.count, 0);
  const ivTotal = aggregate.firstInterviews.reduce((n, e) => n + e.count, 0);

  const targets = [
    { base: env.DASHBOARD_REMOTE_BASE, kind: 'prod' },
    ...(env.DASHBOARD_REMOTE_BASE_DEV
      ? [{ base: env.DASHBOARD_REMOTE_BASE_DEV, kind: 'dev' }]
      : []),
  ];
  await Promise.allSettled(
    targets.map((t) => pushToTarget(env, t, body, { windowStartMs: window.startMs, cvTotal, ivTotal })),
  );
}

/**
 * POST the payload to one target with one immediate retry on 5xx/network
 * error, then give up — the puller heals. 409 (window_mismatch around Monday
 * 00:00, stale when pushes race) and 404 (a target still running a pre-stats
 * dashboard build) are expected terminal outcomes, logged at info, never
 * retried. The 409 `unconfigured` reason is warn — operator-actionable.
 */
async function pushToTarget(env, target, body, logCtx) {
  const url = `${target.base.replace(/\/+$/, '')}/api/remote/stats/stage-weekly`;
  let response = null;
  let networkError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    networkError = null;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Remote-Key': env.DASHBOARD_REMOTE_KEY,
        },
        body,
      });
    } catch (err) {
      networkError = err;
      response = null;
      continue; // network error → one immediate retry
    }
    if (response.status < 500) break; // only 5xx is retried
  }

  const base = {
    source: SOURCE,
    target: target.kind,
    ...logCtx,
  };

  if (networkError || (response && response.status >= 500)) {
    const detail = networkError ? networkError.message : `HTTP ${response.status}`;
    const record = {
      ...base,
      message: `[stage-stats] push to ${target.kind} failed after retry (${detail}) — puller heals`,
      status: response?.status ?? null,
      error: networkError?.message ?? null,
    };
    // The dev container being down is its normal steady state, not an incident.
    if (target.kind === 'prod') console.warn(record);
    else console.log(record);
    return;
  }

  if (response.status === 409) {
    const reason = await response
      .json()
      .then((j) => j?.reason ?? 'unknown')
      .catch(() => 'unknown');
    const record = {
      ...base,
      message: `[stage-stats] push to ${target.kind} rejected: ${reason}`,
      status: 409,
      reason,
    };
    if (reason === 'unconfigured') console.warn(record);
    else console.log(record); // window_mismatch / stale — expected around rollovers and racing pushes
    return;
  }

  if (response.status === 404) {
    console.log({
      ...base,
      message: `[stage-stats] push to ${target.kind} 404 — target runs a pre-stats dashboard build`,
      status: 404,
    });
    return;
  }

  if (!response.ok) {
    console.warn({
      ...base,
      message: `[stage-stats] push to ${target.kind} unexpected status ${response.status}`,
      status: response.status,
    });
    return;
  }

  console.log({
    ...base,
    message: `[stage-stats] push to ${target.kind} applied`,
    status: response.status,
  });
}
