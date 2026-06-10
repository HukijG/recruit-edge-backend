/**
 * `POST /admin/stage-stats/backfill` — cursor-batched historical walk. Seeds
 * history (D1 starts empty) and recovers from any gap or label change
 * (ON CONFLICT updates classification flags in place).
 *
 * UNGATED, deliberately: for historical windows the current stage no longer
 * reflects what happened then (jobs closed/reverted), so gating would drop
 * real crossings — completeness wins on the one-shot path.
 *
 * Each invocation is one bounded batch (subrequest budget); the operator
 * loops with the returned cursor until `done: true`, then calls reconcile
 * once to push.
 */

import { londonDateString } from './week.js';
import { searchActiveCandidates } from './rf-stage-client.js';
import { ingestCandidate } from './ingest.js';
import { requireStatsToken } from './stats-token.js';

const SOURCE = 'stage-stats';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;
const DETAIL_SPACING_MS = 120;

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
