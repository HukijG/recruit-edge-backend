/**
 * Phase 2 live rerank — pulls mutable fields from RF that intentionally
 * aren't in the thin v2 cache (is_open, stage_moved, current stage).
 *
 * The two-phase resolver design (`docs/mcp-middleware.md` § Phase 1 / Phase 2):
 *
 *   Phase 1  cache scoring (`scoreString` on candidates_v2 / jobs_v2)
 *   Phase 2  live RF fan-out (this module)
 *   Phase 3  needs_disambiguation envelope (only if Phase 2 still tied)
 *
 * Two fan-out helpers — `liveRerankJobs` and `liveRerankCandidates` —
 * share the same shape: take a Phase 1 top-K array, fetch each via the
 * appropriate `/get` endpoint at bounded concurrency, apply secondary
 * signals (closed-job filter / stage-based recency boost), return a
 * re-scored sorted list. Per-id failures degrade gracefully — the row
 * keeps its Phase 1 score so a transient RF blip doesn't drop a real
 * match.
 *
 * NB: this module is the WHOLE reason the cache stays write-storm-free —
 * we never need to write is_open or stage_moved to D1 because the live
 * fan-out reads them at disambiguation time. Adding either field to the
 * v2 cache is a regression, not an optimisation.
 */

import { trace } from '@opentelemetry/api';
import { getRFCandidate, getRFJob } from '../rf-client.js';
import { pMapLimit } from './concurrency.js';

/** Fan-out concurrency. 5 ≈ ~150-300ms total against RF's per-call latency. */
const FANOUT_CONCURRENCY = 5;

/**
 * Stages that DON'T count as recency progression. A candidate sitting in
 * Sourced has been "added" but no human has engaged with them; a
 * candidate sitting in Disqualified is dead. Anything else in between
 * (Applied, Replied, CV Sent, Call Booked, Interview, Offer, Hired) is
 * real recruiter activity.
 *
 * Matched case-insensitive against `jobs[i].stage_name`.
 */
const INERT_STAGES = new Set(['sourced', 'disqualified']);

/**
 * Maximum recency boost added to the Phase 1 score. 0.25 is intentionally
 * larger than the extension-penalty / extra-token penalty (≤ 0.10 each)
 * so a recent re-engagement can overcome a Phase 1 deficit, but smaller
 * than UNIQUE_GAP × 4 so we don't blow past Phase 1 confidence on a
 * single weak signal.
 */
const MAX_STAGE_RECENCY_BOOST = 0.25;

/** Recency decay window. Beyond this many days the boost is 0. */
const STAGE_RECENCY_WINDOW_DAYS = 60;

/**
 * Compute the stage-based recency boost for a candidate.
 *
 * Returns 0 if:
 *  - candidate has no jobs[], or
 *  - every job on the candidate is in an inert stage (Sourced /
 *    Disqualified), or
 *  - the most recent non-inert `stage_moved` is older than the
 *    decay window, or
 *  - no non-inert job has a parseable `stage_moved` timestamp.
 *
 * Otherwise returns a value in (0, MAX_STAGE_RECENCY_BOOST] that
 * decays linearly with age. Today → max boost; window edge → 0.
 *
 * Exported for unit testing.
 */
export function stageRecencyBoost(candidate, now = new Date()) {
  if (!candidate || typeof candidate !== 'object') return 0;
  const jobs = Array.isArray(candidate.jobs) ? candidate.jobs : [];
  if (jobs.length === 0) return 0;

  let mostRecentMs = -Infinity;
  for (const j of jobs) {
    const stageName = typeof j?.stage_name === 'string' ? j.stage_name.toLowerCase() : null;
    if (!stageName || INERT_STAGES.has(stageName)) continue;
    const movedAt = j?.stage_moved;
    if (typeof movedAt !== 'string' || !movedAt) continue;
    const ms = Date.parse(movedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > mostRecentMs) mostRecentMs = ms;
  }
  if (!Number.isFinite(mostRecentMs)) return 0;

  const ageDays = (now.getTime() - mostRecentMs) / (1000 * 60 * 60 * 24);
  if (ageDays >= STAGE_RECENCY_WINDOW_DAYS) return 0;
  if (ageDays < 0) {
    // Future-dated stage_moved: tolerate light clock skew (within a week)
    // by treating as "today" and capping the boost. Stamps further in the
    // future are likely corrupt data — return 0 rather than rewarding a
    // garbage timestamp with a max boost.
    if (ageDays > -7) return MAX_STAGE_RECENCY_BOOST;
    return 0;
  }
  return MAX_STAGE_RECENCY_BOOST * (1 - ageDays / STAGE_RECENCY_WINDOW_DAYS);
}

/**
 * Re-score a Phase 1 top-K list of jobs against live RF data.
 *
 * Input:  `[{id, name, client_company_name, score}, ...]` from resolveJob.
 * Output: same shape, filtered (drop is_open=false unless `keepClosed`)
 *         and re-sorted by original score (closed-job filter is the only
 *         signal here — job rerank doesn't apply a recency boost; the
 *         cache name match is already authoritative for open jobs).
 *
 * `opts.keepClosed` (default false) bypasses the closed-job filter.
 * Mirrors the `include_closed` request flag plumbed through tools.ts +
 * the middleware handler. Use sparingly — closed jobs almost always
 * belong on the explicit-numeric-id path.
 *
 * Per-id RF failures keep the row at its Phase 1 score (with a `_phase2`
 * note in case the caller wants to surface the partial state). Empty
 * input → empty output.
 */
export async function liveRerankJobs(env, topK, opts = {}) {
  if (!Array.isArray(topK) || topK.length === 0) return [];
  const keepClosed = opts.keepClosed === true;
  return tracedRerank('mcp.phase2.rerank.jobs', topK, async (span) => {
    const ids = topK.map((j) => j.id);
    const results = await pMapLimit(ids, FANOUT_CONCURRENCY, async (id) =>
      getRFJob(id, env),
    );
    let droppedClosed = 0;
    let fetchFailed = 0;
    const out = [];
    for (let i = 0; i < topK.length; i++) {
      const phase1 = topK[i];
      const r = results[i];
      if (!r.ok) {
        // Transient / per-id failure → keep Phase 1 row, mark partial.
        fetchFailed++;
        out.push({ ...phase1, _phase2: 'fetch_failed' });
        continue;
      }
      const live = r.value;
      // RF returns is_open as boolean; defensively coerce common alternatives.
      const isOpen = live?.is_open === true || live?.is_open === 1 || live?.is_open === 'true';
      if (!keepClosed && live?.is_open != null && !isOpen) {
        droppedClosed++;
        continue;
      }
      // Re-sort key: keep Phase 1 score — closed-job filter is the only
      // signal here. Live job name / client_company_name override Phase 1
      // copies in case the cache row was stale.
      out.push({
        id: phase1.id,
        name: live?.name ?? phase1.name,
        client_company_name: live?.client_company_name ?? phase1.client_company_name,
        score: phase1.score,
        _phase2: 'ok',
      });
    }
    out.sort((a, b) => b.score - a.score);
    if (span) {
      span.setAttribute('mcp.phase2.top_k', topK.length);
      span.setAttribute('mcp.phase2.dropped_closed', droppedClosed);
      span.setAttribute('mcp.phase2.fetch_failed', fetchFailed);
      span.setAttribute('mcp.phase2.survivors', out.length);
      span.setAttribute('mcp.phase2.keep_closed', keepClosed);
    }
    return out;
  });
}

/**
 * Re-score a Phase 1 top-K list of candidates against live RF data.
 *
 * Input:  `[{id, name, score}, ...]` from resolveCandidate.
 * Output: same shape plus `_body` (full canonicalised RF candidate body)
 *         and `_phase2` ('ok' | 'fetch_failed'), sorted by reranked score.
 *
 * Recency signal: `stageRecencyBoost` reads `jobs[].stage_moved` for
 * non-inert stages (not Sourced / Disqualified). When NO eligible stage
 * exists the candidate gets 0 boost — that's by design, matches the
 * operator's "single-name resolution shouldn't be biased by add-time".
 *
 * Per-id RF failures keep the row at its Phase 1 score with no boost.
 */
export async function liveRerankCandidates(env, topK) {
  if (!Array.isArray(topK) || topK.length === 0) return [];
  return tracedRerank('mcp.phase2.rerank.candidates', topK, async (span) => {
    const ids = topK.map((c) => c.id);
    const results = await pMapLimit(ids, FANOUT_CONCURRENCY, async (id) =>
      getRFCandidate(id, env),
    );
    let boostedCount = 0;
    let fetchFailed = 0;
    let recencyWinnerId = null;
    let recencyWinnerBoost = 0;
    const out = [];
    for (let i = 0; i < topK.length; i++) {
      const phase1 = topK[i];
      const r = results[i];
      if (!r.ok) {
        fetchFailed++;
        out.push({ ...phase1, score: phase1.score, _phase2: 'fetch_failed' });
        continue;
      }
      const body = r.value;
      const boost = stageRecencyBoost(body);
      if (boost > 0) {
        boostedCount++;
        if (boost > recencyWinnerBoost) {
          recencyWinnerBoost = boost;
          recencyWinnerId = phase1.id;
        }
      }
      out.push({
        ...phase1,
        name: body?.name ?? phase1.name,
        score: phase1.score + boost,
        _body: body,
        _phase2: 'ok',
      });
    }
    out.sort((a, b) => b.score - a.score);
    if (span) {
      span.setAttribute('mcp.phase2.top_k', topK.length);
      span.setAttribute('mcp.phase2.boosted', boostedCount);
      span.setAttribute('mcp.phase2.fetch_failed', fetchFailed);
      if (recencyWinnerId != null) {
        span.setAttribute('mcp.phase2.recency_winner_id', recencyWinnerId);
        span.setAttribute('mcp.phase2.recency_winner_boost', recencyWinnerBoost);
      }
    }
    return out;
  });
}

/**
 * Wrap a rerank body in a named tracer span so Phase 2 fires are visible
 * in the LD trace tree alongside the auto-instrumented /candidate/get and
 * /job/get child spans. If no global tracer is registered (test
 * environments) the body still runs — the span just goes nowhere.
 */
async function tracedRerank(name, topK, body) {
  const tracer = trace.getTracer('mcp');
  const span = tracer.startSpan(name);
  const t0 = Date.now();
  try {
    const out = await body(span);
    span.setAttribute('mcp.phase2.latency_ms', Date.now() - t0);
    span.setAttribute('mcp.phase2.outcome', 'ok');
    return out;
  } catch (err) {
    span.recordException(err);
    span.setAttribute('mcp.phase2.latency_ms', Date.now() - t0);
    span.setAttribute('mcp.phase2.outcome', 'error');
    throw err;
  } finally {
    span.end();
  }
}
