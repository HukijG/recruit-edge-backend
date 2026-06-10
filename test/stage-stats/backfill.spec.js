import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src';
import { applyStageEventsMigration } from '../helpers/stage-events-migrate.js';

const ROUTE = 'http://example.com/admin/stage-stats/backfill';

const AFTER = Date.parse('2026-05-18T00:00:00Z');
const BEFORE = Date.parse('2026-06-08T00:00:00Z');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(async () => {
  await applyStageEventsMigration(env);
});

const backfillRequest = (body, token = env.STATS_PULL_TOKEN) =>
  new Request(ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { 'X-Stats-Token': token }),
    },
    body: JSON.stringify(body),
  });

/** Mock RF: candidates (PRE-submission stages — backfill must not gate) + one movement each. */
function mockRF(ids) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/candidate/search')) {
      return new Response(
        JSON.stringify({ data: ids.map((id) => ({ id, jobs: [{ stage_name: 'Sourced' }] })) }),
        { status: 200 },
      );
    }
    const id = Number(new URL(url).searchParams.get('id'));
    return new Response(
      JSON.stringify({
        data: {
          jobs: [
            {
              id: 900 + id,
              transitions: [
                { from: 'Sourced', to: 'CV Sent', entered: `2026-05-2${id % 10}T09:00:00+0000`, stage_moved_by: { id: 900005 } },
              ],
            },
          ],
        },
      }),
      { status: 200 },
    );
  });
}

const detailIds = () =>
  globalThis.fetch.mock.calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].url))
    .filter((u) => u.includes('stage-movement'))
    .map((u) => Number(new URL(u).searchParams.get('id')));

describe('POST /admin/stage-stats/backfill', () => {
  it('401s a missing or wrong token (fail closed)', async () => {
    for (const token of [null, 'wrong']) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(backfillRequest({ afterMs: AFTER, beforeMs: BEFORE }, token), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(401);
    }
  });

  it('400s invalid windows and cursors', async () => {
    const bad = [
      {},
      { afterMs: 'x', beforeMs: BEFORE },
      { afterMs: BEFORE, beforeMs: AFTER }, // after >= before
      { afterMs: AFTER, beforeMs: BEFORE, cursor: -1 },
      { afterMs: AFTER, beforeMs: BEFORE, batchSize: 0 },
    ];
    for (const body of bad) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(backfillRequest(body), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(400);
    }
  });

  it('processes ids ascending from the cursor, one bounded batch per invocation', async () => {
    mockRF([9, 3, 7, 1, 5]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      backfillRequest({ afterMs: AFTER, beforeMs: BEFORE, batchSize: 2 }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, done: false, nextCursor: 3, processed: 2 });
    expect(detailIds()).toEqual([1, 3]);
  });

  it('resumes from the cursor and reports done on the final batch', async () => {
    mockRF([9, 3, 7, 1, 5]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      backfillRequest({ afterMs: AFTER, beforeMs: BEFORE, cursor: 3, batchSize: 100 }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, done: true, nextCursor: 9, processed: 3 });
    expect(detailIds()).toEqual([5, 7, 9]);

    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === 'backfill')).toBe(true);
  });

  it('runs UNGATED: pre-submission candidates are still detail-fetched', async () => {
    mockRF([42]); // search rows carry only a Sourced job — a gated walk would drop it
    const ctx = createExecutionContext();
    const res = await worker.fetch(backfillRequest({ afterMs: AFTER, beforeMs: BEFORE }), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, done: true, processed: 1, stored: 1 });
    expect(detailIds()).toEqual([42]);
  });

  it('clamps batchSize to 200', async () => {
    mockRF(Array.from({ length: 3 }, (_, i) => i + 1));
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      backfillRequest({ afterMs: AFTER, beforeMs: BEFORE, batchSize: 9999 }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200); // clamped, not rejected
    const body = await res.json();
    expect(body.processed).toBe(3);
  });

  it('an empty remainder reports done with the cursor unchanged', async () => {
    mockRF([1, 2]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      backfillRequest({ afterMs: AFTER, beforeMs: BEFORE, cursor: 99 }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, done: true, nextCursor: 99, processed: 0, stored: 0 });
  });
});
