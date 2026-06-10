import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src';
import { applyStageEventsMigration } from '../helpers/stage-events-migrate.js';

const ROUTE = 'http://example.com/webhook/recruiterflow/stage-moved';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(async () => {
  await applyStageEventsMigration(env);
});

const webhookRequest = (body, token = env.RF_WEBHOOK_SECRET) =>
  new Request(ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { 'X-RF-Webhook-Token': token }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const rfMovementResponse = (jobs) =>
  new Response(JSON.stringify({ data: { jobs } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('POST /webhook/recruiterflow/stage-moved', () => {
  it('401s a missing token', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 1 } }, null), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it('401s a wrong token', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 1 } }, 'wrong'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it('acknowledges an unparseable payload with 200 + ignored (no retry storm), without calling RF', async () => {
    globalThis.fetch = vi.fn();
    for (const body of ['not json{{', { nothing: true }, { candidate: { id: 'abc' } }]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(webhookRequest(body), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: 'unparseable' });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('500s when the enrichment fetch hard-fails (RF may retry; reconcile heals regardless)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 50256 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // hard 4xx is not retried
  });

  it('happy path: enriches, classifies, stores rows, returns stored count', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      rfMovementResponse([
        {
          id: 984,
          transitions: [
            {
              from: 'Sourced',
              to: 'CV Sent',
              entered: '2026-06-08T08:45:00+0000',
              stage_moved_by: { id: 900005 },
            },
            {
              from: 'CV Sent',
              to: '1st Interview',
              entered: '2026-06-09T10:00:00+0000',
              stage_moved_by: { id: 900005 },
            },
            // pre-submission move: stored too (raw history), classified as neither
            {
              from: 'Sourced',
              to: 'Shortlist',
              entered: '2026-06-07T09:00:00+0000',
              stage_moved_by: { id: 900005 },
            },
          ],
        },
      ]),
    );

    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 50256 }, from_stage: 'Sourced', to_stage: 'CV Sent' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 3 });

    // the enrichment call used the 14-day lookback with seconds-precision params
    const rfUrl = globalThis.fetch.mock.calls[0][0];
    expect(rfUrl).toContain('/candidate/activities/stage-movement/list');
    expect(rfUrl).toContain('id=50256');
    expect(rfUrl).not.toMatch(/\.\d{3}Z/); // no sub-second timestamps (RF 400s)

    const rows = (
      await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events ORDER BY entered_ms').all()
    ).results;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.is_cv_cross, r.is_iv_landing])).toEqual([
      [0, 0], // Sourced → Shortlist
      [1, 0], // Sourced → CV Sent
      [0, 1], // CV Sent → 1st Interview
    ]);
    expect(rows.every((r) => r.source === 'webhook')).toBe(true);
    expect(rows.every((r) => r.mover_rf_id === 900005)).toBe(true);
  });

  it('stores the verbatim entered string as identity (never normalised)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      rfMovementResponse([
        {
          id: 984,
          transitions: [
            { from: null, to: 'CV Sent', entered: '2026-06-08T08:45:00+0000', stage_moved_by: null },
          ],
        },
      ]),
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 50256 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows[0].entered_raw).toBe('2026-06-08T08:45:00+0000');
    expect(rows[0].entered_ms).toBe(Date.parse('2026-06-08T08:45:00Z'));
    expect(rows[0].mover_rf_id).toBeNull();
    expect(rows[0].is_cv_cross).toBe(1); // null from → not submitted → crossing
  });
});
