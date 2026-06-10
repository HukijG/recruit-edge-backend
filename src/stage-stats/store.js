/**
 * STAGE_EVENTS D1 access: the idempotent transition upsert and the two
 * latest-event-wins aggregate queries.
 *
 * The PK (candidate_id, job_id, entered_raw) matches the cross-repo dedup
 * identity. ON CONFLICT UPDATES classification + stages in place (so a
 * backfill re-run after a label change or an RF data fix heals stored flags —
 * INSERT OR IGNORE would fossilise them), COALESCEs the mover (an attributed
 * sighting is never overwritten by an unattributed one), and preserves
 * source/first_seen_ms (provenance of first sighting).
 */

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
 * beforeMs)`. Returns the §4 payload arrays (callers add schema/window/asOf
 * echoes). Counts are per RF user id, unfiltered — every mover present in the
 * data, including ids the dashboard doesn't track; presentation mapping is
 * the dashboard's job.
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
