/**
 * Stage-movement stats plane — one module, like the repo's other feature
 * spheres (cold-call.js, krisp.js, enrichment.js). See docs/stage-stats.md
 * for the full architecture; the short version:
 *
 *   RF stage-moved webhook ─┐
 *   hourly reconcile cron  ─┼─► ingest (fetch transitions → classify →
 *   admin backfill         ─┘    idempotent upsert into STAGE_EVENTS D1)
 *                                      │
 *                                      ▼
 *                    latest-event-wins weekly aggregate
 *                       │                       │
 *                       ▼                       ▼
 *            push → dashboard ingress   GET /stats/stage-aggregate (pull)
 *
 * Sections below: week windows · classification · D1 store · token gate ·
 * ingest engine · push · route handlers (webhook / pull / reconcile /
 * backfill). RF calls live in rf-client.js (the canonical RF client).
 */

import { trace } from '@opentelemetry/api';
import { timingSafeEqual } from './lib/timing-safe-equal.js';
import {
  fetchStageMovements,
  searchCandidatesByPredicateOnly,
  toIntOrNull,
} from './rf-client.js';

const SOURCE = 'stage-stats';

// ───────────────────────────── Week windows ────────────────────────────────
// London-aware Mon–Sun week windows, DST-correct, dependency-free.
//
// The dashboard computes the same boundary with chrono-tz; both are
// IANA-driven so they agree except within the DST-transition instant itself,
// which never coincides with a London midnight (UK transitions happen at
// 01:00 GMT). All functions take/return UTC epoch milliseconds.

const LONDON_PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** London wall-clock fields at the given instant. */
function londonWallClock(ms) {
  const parts = {};
  for (const p of LONDON_PARTS_FMT.formatToParts(ms)) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  return parts;
}

/**
 * The UTC instant at which the London wall clock reads `YYYY-MM-DD 00:00:00`.
 *
 * Guess UTC midnight, measure how far the London wall clock at the guess is
 * from the target, and correct. London midnight never falls inside a DST gap
 * (transitions are at 01:00 GMT), so two iterations always converge.
 */
function londonMidnightUtcMs(year, month, day) {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const w = londonWallClock(guess);
    const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const diff = wallAsUtc - target;
    if (diff === 0) return guess;
    guess -= diff;
  }
  return guess;
}

/** The Monday (as {year, month, day}) of the London local date containing `ms`. */
function mondayOfLondonDate(ms) {
  const w = londonWallClock(ms);
  // Pure date arithmetic on the London calendar date (safe at UTC: no tz here,
  // just walking a y/m/d triple back to its Monday).
  const dateUtc = Date.UTC(w.year, w.month - 1, w.day);
  const sinceMonday = (new Date(dateUtc).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(dateUtc - sinceMonday * 86_400_000);
  return {
    year: monday.getUTCFullYear(),
    month: monday.getUTCMonth() + 1,
    day: monday.getUTCDate(),
  };
}

/** Shift a {year, month, day} triple by whole days (calendar-date arithmetic). */
function shiftDate({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The Mon–Sun week containing `nowMs`: Monday 00:00 Europe/London through the
 * NEXT Monday 00:00 Europe/London, both as UTC epoch ms. The end boundary is
 * re-resolved through the timezone (not start + 7×24h) so DST-transition weeks
 * are 167h/169h as appropriate.
 *
 * @param {number} nowMs
 * @returns {{ startMs: number, endMs: number }}
 */
export function currentWeekWindowLondon(nowMs) {
  const monday = mondayOfLondonDate(nowMs);
  const next = shiftDate(monday, 7);
  return {
    startMs: londonMidnightUtcMs(monday.year, monday.month, monday.day),
    endMs: londonMidnightUtcMs(next.year, next.month, next.day),
  };
}

/**
 * Monday 00:00 Europe/London of the week BEFORE the one containing `nowMs`,
 * as UTC epoch ms.
 *
 * @param {number} nowMs
 * @returns {number}
 */
export function previousWeekStartLondon(nowMs) {
  const monday = mondayOfLondonDate(nowMs);
  const prev = shiftDate(monday, -7);
  return londonMidnightUtcMs(prev.year, prev.month, prev.day);
}

/**
 * The London local calendar date containing `ms`, as `YYYY-MM-DD`. Used as the
 * day-granular `last_activity after` floor for RF candidate/search walks.
 *
 * @param {number} ms
 * @returns {string}
 */
export function londonDateString(ms) {
  const w = londonWallClock(ms);
  const mm = String(w.month).padStart(2, '0');
  const dd = String(w.day).padStart(2, '0');
  return `${w.year}-${mm}-${dd}`;
}

// ──────────────────────────── Classification ───────────────────────────────
// Stage-label classification for the stats plane.
//
// KEPT IN LOCKSTEP with company_dashboard/server/config/consultants.json
// (`pre_submission_stage_labels`, `first_interview_stage_labels`). When the
// label sets change, edit BOTH files together, then re-run the backfill
// (POST /admin/stage-stats/backfill) over the horizon you care about — the
// is_cv_cross / is_iv_landing flags are denormalised into D1 at write time
// and do not self-heal on a label change.
//
// Counting semantics (canonical, shared with the dashboard):
//  - Submitted territory is a DENYLIST: a stage is submitted-or-beyond unless
//    its trimmed, lowercased name is in PRE_SUBMISSION_STAGES or contains
//    "disqualif". Empty/whitespace-only/missing names are NOT submitted.
//  - CV-Sent crossing: is_submitted(to) && !is_submitted(from); a missing
//    `from` counts as not-submitted, so a first entry straight into submitted
//    territory IS a crossing, and stage-skipping jumps are crossings.
//  - 1st-Interview landing: trimmed, lowercased `to` is in
//    FIRST_INTERVIEW_STAGES (allowlist).

export const PRE_SUBMISSION_STAGES = new Set([
  'sourced', 'applied', 'replied', 'replied (cold)', 'call booked', 'shortlist',
  'new lead', 'new', 'contacted', 'prospect', 'screening',
]);

export const FIRST_INTERVIEW_STAGES = new Set([
  '1st interview', 'first interview', 'client interview 1', 'client interview',
  'interview 1',
]);

/**
 * Denylist test: a stage is "submitted territory" (CV-Sent-or-beyond) unless
 * it is empty, disqualified, or a configured pre-submission stage. Errs toward
 * counting an unknown stage as submitted — a wasted event row is harmless, a
 * silently dropped submission is not.
 *
 * @param {string|null|undefined} stageName
 * @returns {boolean}
 */
export function isSubmittedStage(stageName) {
  if (stageName === null || stageName === undefined) return false;
  const n = String(stageName).trim().toLowerCase();
  if (n === '' || n.includes('disqualif')) return false;
  return !PRE_SUBMISSION_STAGES.has(n);
}

/**
 * Classify one stage transition.
 *
 * @param {string|null|undefined} fromStage
 * @param {string|null|undefined} toStage
 * @returns {{ isCvCross: boolean, isIvLanding: boolean }}
 */
export function classifyTransition(fromStage, toStage) {
  const toSubmitted = isSubmittedStage(toStage);
  const fromSubmitted = isSubmittedStage(fromStage);
  const toNorm = toStage === null || toStage === undefined
    ? ''
    : String(toStage).trim().toLowerCase();
  return {
    isCvCross: toSubmitted && !fromSubmitted,
    isIvLanding: FIRST_INTERVIEW_STAGES.has(toNorm),
  };
}

// ─────────────────────────────── D1 store ──────────────────────────────────
// STAGE_EVENTS access: the idempotent transition upsert and the two
// latest-event-wins aggregate queries.
//
// The PK (candidate_id, job_id, entered_raw) matches the cross-repo dedup
// identity. ON CONFLICT UPDATES classification + stages in place (so a
// backfill re-run after a label change or an RF data fix heals stored flags —
// INSERT OR IGNORE would fossilise them), COALESCEs the mover (an attributed
// sighting is never overwritten by an unattributed one), and preserves
// source/first_seen_ms (provenance of first sighting).

const UPSERT_SQL = `
INSERT INTO stage_events
  (candidate_id, job_id, entered_raw, entered_ms, from_stage, to_stage,
   mover_rf_id, is_cv_cross, is_iv_landing, source, first_seen_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT (candidate_id, job_id, entered_raw) DO UPDATE SET
  from_stage = excluded.from_stage,
  to_stage = excluded.to_stage,
  mover_rf_id = COALESCE(excluded.mover_rf_id, mover_rf_id),
  is_cv_cross = excluded.is_cv_cross,
  is_iv_landing = excluded.is_iv_landing
`;

/**
 * Upsert classified transition rows. Idempotent — replaying the same rows is
 * a no-op race even from concurrent invocations (PK + ON CONFLICT).
 *
 * @param {*} env
 * @param {Array<{candidateId: number, jobId: number, enteredRaw: string, enteredMs: number,
 *                fromStage: string|null, toStage: string|null, moverRfId: number|null,
 *                isCvCross: boolean, isIvLanding: boolean}>} rows
 * @param {string} source - 'webhook' | 'reconcile' | 'backfill'
 * @param {number} nowMs - first_seen_ms for rows not previously sighted
 * @returns {Promise<number>} rows written
 */
export async function upsertRows(env, rows, source, nowMs) {
  if (rows.length === 0) return 0;
  const stmt = env.STAGE_EVENTS.prepare(UPSERT_SQL);
  await env.STAGE_EVENTS.batch(
    rows.map((r) =>
      stmt.bind(
        r.candidateId,
        r.jobId,
        r.enteredRaw,
        r.enteredMs,
        r.fromStage,
        // '' == null for classification (both are "not submitted"); the empty
        // string just satisfies the NOT NULL column.
        r.toStage ?? '',
        r.moverRfId,
        r.isCvCross ? 1 : 0,
        r.isIvLanding ? 1 : 0,
        source,
        nowMs,
      ),
    ),
  );
  return rows.length;
}

/**
 * Latest-event-wins per (candidate, job) pair, then window-filter, then group
 * by mover. The `(mover_rf_id IS NULL) ASC` tiebreak prefers an attributed row
 * over an unattributed duplicate at the same instant. NULL-mover groups come
 * back as `rfUserId: null` — the dashboard's mapper drops them, but they still
 * suppress older attributed events for their pair (latest truth wins, by
 * design).
 *
 * The inner scan deliberately covers ALL flagged history, not just the
 * window: a pair's most recent event decides which week (if any) the pair
 * counts in, so a last-week pull must see this week's events to know a
 * last-week crossing was superseded. Pre-filtering by the window would
 * resurrect superseded events. The covering partial indexes
 * (migrations-stage-events/0002) make the full scan one index row per
 * flagged event.
 */
const aggregateSql = (flagColumn) => `
SELECT mover_rf_id, COUNT(*) AS n FROM (
  SELECT candidate_id, job_id, mover_rf_id, entered_ms,
         ROW_NUMBER() OVER (
           PARTITION BY candidate_id, job_id
           ORDER BY entered_ms DESC, (mover_rf_id IS NULL) ASC, entered_raw DESC
         ) AS rn
  FROM stage_events
  WHERE ${flagColumn} = 1
) WHERE rn = 1 AND entered_ms >= ?1 AND entered_ms < ?2
GROUP BY mover_rf_id
`;

const CV_AGGREGATE_SQL = aggregateSql('is_cv_cross');
const IV_AGGREGATE_SQL = aggregateSql('is_iv_landing');

/**
 * Compute the per-mover CV-Sent / 1st-Interview aggregate for `[afterMs,
 * beforeMs)`. Returns the wire-contract payload arrays (callers add
 * schema/window/asOf echoes). Counts are per RF user id, unfiltered — every
 * mover present in the data, including ids the dashboard doesn't track;
 * presentation mapping is the dashboard's job.
 *
 * @param {*} env
 * @param {number} afterMs
 * @param {number} beforeMs
 * @returns {Promise<{cvSent: Array<{rfUserId: number|null, count: number}>,
 *                    firstInterviews: Array<{rfUserId: number|null, count: number}>}>}
 */
export async function computeAggregate(env, afterMs, beforeMs) {
  const [cv, iv] = await env.STAGE_EVENTS.batch([
    env.STAGE_EVENTS.prepare(CV_AGGREGATE_SQL).bind(afterMs, beforeMs),
    env.STAGE_EVENTS.prepare(IV_AGGREGATE_SQL).bind(afterMs, beforeMs),
  ]);
  const toEntries = (res) =>
    (res.results ?? []).map((row) => ({
      rfUserId: row.mover_rf_id ?? null,
      count: Number(row.n),
    }));
  return { cvSent: toEntries(cv), firstInterviews: toEntries(iv) };
}

// ─────────────────────────────── Token gate ────────────────────────────────

/**
 * `X-Stats-Token` gate for the stats pull + admin routes
 * (`GET /stats/stage-aggregate`, `POST /admin/stage-stats/*`).
 *
 * Machine-to-machine routes (the dashboard server / operator curl) — NOT
 * user-facing, so per docs/security.md they use a shared-token header, not
 * Cloudflare Access. Fail closed: no configured secret ⇒ every request 401s.
 *
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

// ───────────────────────────── Ingest engine ───────────────────────────────
// Webhook, reconcile, and backfill all funnel through `ingestCandidate`, so
// the fetch → classify → upsert pipeline cannot drift between paths.

/** Spacing between per-candidate RF detail calls on walk paths (RF courtesy). */
const DETAIL_SPACING_MS = 120;

/**
 * Fetch ALL transitions for ONE candidate in `[afterMs, beforeMs)`, classify,
 * upsert. Every transition the fetch returns is stored (pre-submission moves
 * too — volume is trivial and the raw from/to history is what makes future
 * metrics and reclassification possible). Transitions whose `entered` is
 * missing or unparseable are skipped with a warn — without a verbatim
 * timestamp there is no identity to store under.
 *
 * @param {*} env
 * @param {number} candidateId
 * @param {number} afterMs
 * @param {number} beforeMs
 * @param {string} source - 'webhook' | 'reconcile' | 'backfill'
 * @returns {Promise<{fetched: number, stored: number}>}
 */
export async function ingestCandidate(env, candidateId, afterMs, beforeMs, source) {
  const transitions = await fetchStageMovements(env, candidateId, afterMs, beforeMs);
  const rows = [];
  for (const t of transitions) {
    if (t.enteredRaw === null || t.enteredMs === null) {
      console.warn({
        message: `[stage-stats] candidate ${candidateId} transition has missing/unparseable entered — skipped`,
        source: SOURCE,
        candidateId,
        jobId: t.jobId,
        enteredRaw: t.enteredRaw,
      });
      continue;
    }
    const { isCvCross, isIvLanding } = classifyTransition(t.fromStage, t.toStage);
    rows.push({ candidateId, ...t, isCvCross, isIvLanding });
  }
  const stored = await upsertRows(env, rows, source, Date.now());
  return { fetched: transitions.length, stored };
}

/**
 * Paginated `POST candidate/search` filtered to `last_activity after
 * <sinceDate>` (absolute, DAY-granular — callers floor a day below their
 * window start), via the shared rf-client pagination. This is the same
 * lagging search index the webhook path escapes — fine here: reconcile and
 * backfill are backstops measured in hours.
 *
 * @param {*} env
 * @param {string} sinceDate - `YYYY-MM-DD` (Europe/London local date)
 * @returns {Promise<Array<{id: number, jobs: Array<{jobId: number|null,
 *           stageName: string|null, prevStageName: string|null}>}>>}
 */
async function searchActiveCandidates(env, sinceDate) {
  const { candidates } = await searchCandidatesByPredicateOnly(
    {
      predicateFilters: [
        { key: 'last_activity', is_relative: false, filter_type: 'after', date: sinceDate },
      ],
      maxPages: 50,
    },
    env,
  );
  return candidates
    .map((row) => ({
      id: toIntOrNull(row?.id),
      jobs: Array.isArray(row?.jobs)
        ? row.jobs.map((j) => ({
            jobId: toIntOrNull(j?.job_id),
            stageName: typeof j?.stage_name === 'string' ? j.stage_name : null,
            prevStageName:
              typeof j?.previous_stage_details?.prev_stage_name === 'string'
                ? j.previous_stage_details.prev_stage_name
                : null,
          }))
        : [],
    }))
    .filter((c) => c.id !== null);
}

/**
 * The reconcile gate: keep a candidate when any search-row job's CURRENT
 * stage is in submitted territory, judging a `disqualif*` stage by the
 * previous stage (DQ is off the linear ladder; unknown previous → keep).
 * Exists purely to bound RF detail calls on the recurring path — backfill
 * runs ungated because a historical window's current stage no longer reflects
 * what happened then.
 *
 * @param {Array<{stageName: string|null, prevStageName: string|null}>} jobs
 * @returns {boolean}
 */
export function passesSubmissionGate(jobs) {
  for (const j of jobs) {
    const cur = (j.stageName ?? '').trim();
    if (!cur) continue;
    if (cur.toLowerCase().includes('disqualif')) {
      const prev = (j.prevStageName ?? '').trim();
      if (!prev || isSubmittedStage(prev)) return true;
    } else if (isSubmittedStage(cur)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk a window: candidate/search, optionally gate, then `ingestCandidate`
 * for each with ~120ms spacing between RF detail calls. A failed candidate is
 * logged and skipped — one bad fetch never tanks the sweep, and the next run
 * retries (upserts are idempotent).
 *
 * @param {*} env
 * @param {{afterMs: number, beforeMs: number, gate: boolean, source: string}} opts
 * @returns {Promise<{candidates: number, gated: number, fetched: number, stored: number, failed: number}>}
 */
export async function ingestWindow(env, { afterMs, beforeMs, gate, source }) {
  const sinceDate = londonDateString(afterMs - 86_400_000);
  const candidates = await searchActiveCandidates(env, sinceDate);
  const targets = gate ? candidates.filter((c) => passesSubmissionGate(c.jobs)) : candidates;

  let fetched = 0;
  let stored = 0;
  let failed = 0;
  for (const c of targets) {
    try {
      const r = await ingestCandidate(env, c.id, afterMs, beforeMs, source);
      fetched += r.fetched;
      stored += r.stored;
    } catch (err) {
      failed += 1;
      console.warn({
        message: `[stage-stats] ${source}: ingest failed for candidate ${c.id}: ${err?.message}`,
        source: SOURCE,
        candidateId: c.id,
        error: err?.message,
      });
    }
    await new Promise((r) => setTimeout(r, DETAIL_SPACING_MS));
  }
  return { candidates: candidates.length, gated: targets.length, fetched, stored, failed };
}

// ──────────────────────────────── Push ─────────────────────────────────────
// Aggregate → dashboard push: recompute the current Mon–Sun London week from
// D1 and POST it to every configured ingress target. Push is the fast path
// (event → TV in seconds); the dashboard's puller is the seed/heal path —
// both carry the same payload shape.
//
// Fan-out: `DASHBOARD_REMOTE_BASE` (prod — required for the plane to push at
// all) and `DASHBOARD_REMOTE_BASE_DEV` (optional additional target; unset ⇒
// single-target). Targets are fully independent — one target's failure never
// affects the other.

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
    // one whose push started earlier ("when the aggregate was computed").
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

// ───────────────────────────── Webhook route ───────────────────────────────
// `POST /webhook/recruiterflow/stage-moved` — the event-driven entry of the
// stats plane.
//
// RF's webhook payload carries event_time / from_stage / to_stage /
// candidate{} / job{} and NO mover — which is why the handler ignores the
// payload's own transition fields and enriches against RF's TRANSACTIONAL
// stage-movement endpoint instead (instant consistency, carries the mover;
// attribution is non-negotiable). One row shape, one identity — no
// payload-vs-list timestamp mismatch class of bugs.
//
// The enrichment window is deliberately much wider than "this event"
// (14 days): one cheap GET returns ALL of the candidate's recent transitions,
// so a webhook for one move also self-heals any previously-missed moves for
// the same candidate, including the other job in a two-job submission burst.
//
// The operator configures the RF hook to fire on stage moves into
// CV-Sent-and-beyond stages — but correctness never relies on RF's stage
// filter; classification happens server-side. The filter only trims volume.

/** How far back the enrichment fetch reaches from "now". */
export const ENRICH_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Handler flow (synchronous through the D1 write; push deferred):
 *   verify token → 401 on mismatch (fail closed when the secret is unset)
 *   parse JSON; require candidate.id → 200 {ok, ignored} + loud warn
 *     (a malformed hook must NOT retry-storm; body-capture logs the payload)
 *   ingestCandidate over the 14-day lookback → 500 on throw (RF may retry;
 *     the reconcile cron heals regardless)
 *   ctx.waitUntil(recomputeAndPush) → fire-and-forget
 *
 * @param {Request} request
 * @param {*} env
 * @param {*} ctx
 * @returns {Promise<Response>}
 */
export async function handleStageMovedWebhook(request, env, ctx) {
  const secret = env.RF_WEBHOOK_SECRET;
  const token = request.headers.get('X-RF-Webhook-Token');
  if (!secret || !token || !timingSafeEqual(token, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let payload = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  const candidateId = Number(payload?.candidate?.id);
  if (!payload || !Number.isInteger(candidateId) || candidateId <= 0) {
    console.warn({
      message:
        '[stage-stats] stage-moved webhook payload unparseable (no integer candidate.id) — acknowledged without processing',
      source: SOURCE,
      candidateIdRaw: payload?.candidate?.id ?? null,
    });
    return Response.json({ ok: true, ignored: 'unparseable' });
  }

  // The payload's own from/to are span attributes only (observability) —
  // never written to D1; the enrichment rows are the single canonical shape.
  const span = trace.getActiveSpan();
  span?.setAttribute('rf.event_type', 'stage_moved');
  if (typeof payload.from_stage === 'string') span?.setAttribute('rf.from_stage', payload.from_stage);
  if (typeof payload.to_stage === 'string') span?.setAttribute('rf.to_stage', payload.to_stage);

  const startedAt = Date.now();
  let result;
  try {
    result = await ingestCandidate(env, candidateId, startedAt - ENRICH_LOOKBACK_MS, startedAt, 'webhook');
  } catch (err) {
    console.error({
      message: `[stage-stats] stage-moved enrichment failed for candidate ${candidateId}: ${err?.message}`,
      source: SOURCE,
      candidateId,
      error: err?.message,
    });
    return Response.json({ ok: false, error: 'enrichment failed' }, { status: 500 });
  }

  console.log({
    message: `[stage-stats] stage-moved candidate=${candidateId} stored=${result.stored}`,
    source: SOURCE,
    candidateId,
    stored: result.stored,
    tookMs: Date.now() - startedAt,
  });

  ctx.waitUntil(recomputeAndPush(env));
  return Response.json({ ok: true, stored: result.stored });
}

// ───────────────────────────── Reconcile ───────────────────────────────────
// The backstop for missed/failed webhooks (worker down, RF outage, 500s RF
// never retried, rate-limit residue).
//
// The window reaches back to the PREVIOUS week's Monday (Europe/London) so
// the last-week aggregate keeps healing across the weekly boundary — a move
// missed Sunday 23:50 is still swept on Monday, which is what the dashboard's
// LAST-WEEK toggle reads. Gated (reached-submission) to bound RF detail
// calls; the gate's residual hole is recoverable via an ungated backfill.
//
// Runs hourly from cron (`7 * * * *` → src/index.js `scheduled()`) and on
// demand via `POST /admin/stage-stats/reconcile`.

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

// ─────────────────────────────── Pull route ────────────────────────────────
// `GET /stats/stage-aggregate?afterMs=&beforeMs=` (auth `X-Stats-Token`) —
// the pull side of the wire contract. The window is caller-chosen: the
// dashboard's puller asks for the current week, the last-week toggle for the
// previous week, ad-hoc audits for anything else.

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

// ───────────────────────────── Backfill route ──────────────────────────────
// `POST /admin/stage-stats/backfill` — cursor-batched historical walk. Seeds
// history (D1 starts empty) and recovers from any gap or label change
// (ON CONFLICT updates classification flags in place).
//
// UNGATED, deliberately: for historical windows the current stage no longer
// reflects what happened then (jobs closed/reverted), so gating would drop
// real crossings — completeness wins on the one-shot path.
//
// Each invocation is one bounded batch (subrequest budget); the operator
// loops with the returned cursor until `done: true`, then calls reconcile
// once to push.

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;

/**
 * Body: `{ afterMs, beforeMs, cursor?, batchSize? }` — cursor is a
 * candidate-id watermark (process ids strictly greater than it, ascending).
 * Response: `{ ok, done, nextCursor, processed, stored, failed }`.
 *
 * @param {Request} request
 * @param {*} env
 * @returns {Promise<Response>}
 */
export async function handleBackfillRoute(request, env) {
  const denied = requireStatsToken(request, env);
  if (denied) return denied;

  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const afterMs = Number(body?.afterMs);
  const beforeMs = Number(body?.beforeMs);
  const cursor = body?.cursor === undefined ? 0 : Number(body.cursor);
  const batchSize =
    body?.batchSize === undefined
      ? DEFAULT_BATCH_SIZE
      : Math.min(Number(body.batchSize), MAX_BATCH_SIZE);
  if (
    !Number.isInteger(afterMs) ||
    !Number.isInteger(beforeMs) ||
    afterMs >= beforeMs ||
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    !Number.isInteger(batchSize) ||
    batchSize < 1
  ) {
    return Response.json(
      { ok: false, error: 'body must carry integer afterMs < beforeMs, optional cursor >= 0, optional batchSize >= 1' },
      { status: 400 },
    );
  }

  // One paginated search per invocation (~5 pages) — the cursor selects which
  // slice of the id-ordered result this batch processes, so re-invocations
  // see a stable ordering even as RF activity moves on.
  const sinceDate = londonDateString(afterMs - 86_400_000);
  const candidates = await searchActiveCandidates(env, sinceDate);
  const remaining = [...new Set(candidates.map((c) => c.id))]
    .sort((a, b) => a - b)
    .filter((id) => id > cursor);
  const batch = remaining.slice(0, batchSize);

  let stored = 0;
  let failed = 0;
  for (const id of batch) {
    try {
      const r = await ingestCandidate(env, id, afterMs, beforeMs, 'backfill');
      stored += r.stored;
    } catch (err) {
      failed += 1;
      console.warn({
        message: `[stage-stats] backfill: ingest failed for candidate ${id}: ${err?.message}`,
        source: SOURCE,
        candidateId: id,
        error: err?.message,
      });
    }
    await new Promise((r) => setTimeout(r, DETAIL_SPACING_MS));
  }

  const nextCursor = batch.length > 0 ? batch[batch.length - 1] : cursor;
  const done = batch.length === remaining.length;
  console.log({
    message: `[stage-stats] backfill batch: processed=${batch.length} stored=${stored} failed=${failed} nextCursor=${nextCursor} done=${done}`,
    source: SOURCE,
    processed: batch.length,
    stored,
    failed,
    nextCursor,
    done,
  });
  return Response.json({ ok: true, done, nextCursor, processed: batch.length, stored, failed });
}
