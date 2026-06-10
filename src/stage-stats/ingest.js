/**
 * The shared ingest engine: webhook, reconcile, and backfill all funnel
 * through `ingestCandidate`, so the fetch → classify → upsert pipeline cannot
 * drift between paths.
 */

import { classifyTransition, isSubmittedStage } from './classify.js';
import { fetchStageMovements, searchActiveCandidates } from './rf-stage-client.js';
import { londonDateString } from './week.js';
import { upsertRows } from './store.js';

const SOURCE = 'stage-stats';

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
 * Walk a window: candidate/search (last_activity floored ONE DAY below
 * `afterMs` in Europe/London — RF's filter is day-granular), optionally gate,
 * then `ingestCandidate` for each with ~120ms spacing between RF detail
 * calls. A failed candidate is logged and skipped — one bad fetch never tanks
 * the sweep, and the next run retries (upserts are idempotent).
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
