import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src';
import { applyStageEventsMigration } from '../helpers/stage-events-migrate.js';
import { DEFAULT_PIPELINE, pipelineResponse } from '../helpers/rf-pipeline-mock.js';

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

/**
 * URL-dispatching RF mock: stage-movement list + per-job pipeline.
 * `pipelinesByJob` maps jobId → ordered stage-name list (default pipeline
 * when the id is unmapped).
 */
function mockRF(movementJobs, pipelinesByJob = {}) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/candidate/activities/stage-movement/list')) {
      return rfMovementResponse(movementJobs);
    }
    if (url.includes('/job/pipeline')) {
      const jobId = Number(new URL(url).searchParams.get('job_id'));
      return pipelineResponse(pipelinesByJob[jobId] ?? DEFAULT_PIPELINE);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

const pipelineCalls = () =>
  globalThis.fetch.mock.calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].url))
    .filter((u) => u.includes('/job/pipeline'));

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

  it('happy path: enriches, classifies positionally, stores rows, returns stored count', async () => {
    mockRF([
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
    ]);

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

    // three transitions on one job → ONE pipeline fetch (memoised)
    expect(pipelineCalls()).toHaveLength(1);
    expect(pipelineCalls()[0]).toContain('job_id=984');

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

  it('classifies against the JOB’S OWN pipeline: a pre-landmark custom stage is not submitted', async () => {
    mockRF(
      [
        {
          id: 777,
          transitions: [
            // 'Client Review' sits BEFORE 'CV Sent' in job 777's pipeline — the
            // old denylist would have miscounted this as a CV crossing.
            { from: 'Sourced', to: 'Client Review', entered: '2026-06-08T09:00:00+0000', stage_moved_by: { id: 900005 } },
            { from: 'Client Review', to: 'CV Sent', entered: '2026-06-08T10:00:00+0000', stage_moved_by: { id: 900005 } },
            { from: 'CV Sent', to: 'Client Interview 1', entered: '2026-06-08T11:00:00+0000', stage_moved_by: { id: 900005 } },
          ],
        },
      ],
      { 777: ['Sourced', 'Client Review', 'CV Sent', 'Client Interview 1', 'Offer', 'Disqualified'] },
    );

    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 60001 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const rows = (
      await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events ORDER BY entered_ms').all()
    ).results;
    expect(rows.map((r) => [r.to_stage, r.is_cv_cross, r.is_iv_landing])).toEqual([
      ['Client Review', 0, 0],
      ['CV Sent', 1, 0],
      ['Client Interview 1', 0, 1],
    ]);
  });

  it('a job whose pipeline lacks the CV Sent landmark stores rows unclassified', async () => {
    mockRF(
      [
        {
          id: 555,
          transitions: [
            { from: 'Sourced', to: 'Hired', entered: '2026-06-08T09:00:00+0000', stage_moved_by: { id: 900001 } },
          ],
        },
      ],
      { 555: ['Sourced', 'Screening', 'Hired'] },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 60002 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1 });

    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows[0].is_cv_cross).toBe(0);
    expect(rows[0].is_iv_landing).toBe(0);
  });

  it('a transient pipeline failure 500s the webhook before any row is written (atomic)', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/candidate/activities/stage-movement/list')) {
        return rfMovementResponse([
          {
            id: 888,
            transitions: [
              { from: 'Sourced', to: 'CV Sent', entered: '2026-06-08T09:00:00+0000', stage_moved_by: { id: 900005 } },
            ],
          },
        ]);
      }
      return new Response('rf is down', { status: 503 }); // pipeline fetch fails
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 60003 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows).toHaveLength(0);
  });

  it('reuses the KV-cached pipeline across invocations (one fetch, then zero)', async () => {
    const movement = [
      {
        id: 984,
        transitions: [
          { from: 'Sourced', to: 'CV Sent', entered: '2026-06-08T08:45:00+0000', stage_moved_by: { id: 900005 } },
        ],
      },
    ];
    mockRF(movement);
    let ctx = createExecutionContext();
    await worker.fetch(webhookRequest({ candidate: { id: 50256 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(pipelineCalls()).toHaveLength(1);

    mockRF(movement); // fresh mock, fresh invocation — KV still warm
    ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 50256 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(pipelineCalls()).toHaveLength(0);
  });

  it('self-heals a stale KV pipeline: unknown stage triggers one fresh refetch', async () => {
    // Warm the KV cache with a pipeline that predates a rename.
    await env.SYNC_STATE.put(
      'stagestats:pipeline:984',
      JSON.stringify(['Sourced', 'Old Stage Name', 'CV Sent', '1st Interview']),
    );
    mockRF([
      {
        id: 984,
        transitions: [
          // 'Shortlist' is unknown to the stale cache, known to the live pipeline.
          { from: 'Shortlist', to: 'CV Sent', entered: '2026-06-08T08:45:00+0000', stage_moved_by: { id: 900005 } },
        ],
      },
    ]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 50256 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(pipelineCalls()).toHaveLength(1); // the self-heal refetch

    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows[0].is_cv_cross).toBe(1); // classified against the FRESH list
  });

  it('skips (does not store, does not crash on) transitions with missing/unparseable entered', async () => {
    mockRF([
      {
        id: 984,
        transitions: [
          { from: 'Sourced', to: 'CV Sent', entered: null, stage_moved_by: { id: 900005 } },
          { from: 'Sourced', to: 'CV Sent', entered: '12/06/2026 09:00', stage_moved_by: { id: 900005 } },
          { from: 'Sourced', to: 'CV Sent', entered: '2026-06-08T08:45:00+0000', stage_moved_by: { id: 900005 } },
        ],
      },
    ]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(webhookRequest({ candidate: { id: 50256 } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1 }); // only the parseable one
    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].entered_raw).toBe('2026-06-08T08:45:00+0000');
  });

  it('stores the verbatim entered string as identity (never normalised)', async () => {
    mockRF([
      {
        id: 984,
        transitions: [
          { from: null, to: 'CV Sent', entered: '2026-06-08T08:45:00+0000', stage_moved_by: null },
        ],
      },
    ]);
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
