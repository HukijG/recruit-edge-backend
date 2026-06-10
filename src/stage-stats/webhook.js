/**
 * `POST /webhook/recruiterflow/stage-moved` — the event-driven entry of the
 * stats plane.
 *
 * RF's webhook payload carries event_time / from_stage / to_stage /
 * candidate{} / job{} and NO mover — which is why the handler ignores the
 * payload's own transition fields and enriches against RF's TRANSACTIONAL
 * stage-movement endpoint instead (instant consistency, carries the mover;
 * attribution is non-negotiable). One row shape, one identity — no
 * payload-vs-list timestamp mismatch class of bugs.
 *
 * The enrichment window is deliberately much wider than "this event"
 * (14 days): one cheap GET returns ALL of the candidate's recent transitions,
 * so a webhook for one move also self-heals any previously-missed moves for
 * the same candidate, including the other job in a two-job submission burst.
 *
 * The operator configures the RF hook to fire on stage moves into
 * CV-Sent-and-beyond stages — but correctness never relies on RF's stage
 * filter; classification happens server-side. The filter only trims volume.
 */

import { trace } from '@opentelemetry/api';
import { timingSafeEqual } from '../lib/timing-safe-equal.js';
import { ingestCandidate } from './ingest.js';
import { recomputeAndPush } from './push.js';

const SOURCE = 'stage-stats';

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
