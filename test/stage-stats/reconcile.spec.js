import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src';
import { applyStageEventsMigration } from '../helpers/stage-events-migrate.js';
import { passesSubmissionGate } from '../../src/stage-stats/ingest.js';

const ROUTE = 'http://example.com/admin/stage-stats/reconcile';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(async () => {
  await applyStageEventsMigration(env);
});

const reconcileRequest = (token = env.STATS_PULL_TOKEN) =>
  new Request(ROUTE, {
    method: 'POST',
    headers: token === null ? {} : { 'X-Stats-Token': token },
  });

const searchRow = (id, jobs) => ({ id, jobs });
// Raw RF search-row job shape (what the mocked /candidate/search returns).
const job = (stageName, prevStageName = null) => ({
  stage_name: stageName,
  previous_stage_details: prevStageName === null ? undefined : { prev_stage_name: prevStageName },
});
// Flattened shape (what searchActiveCandidates hands to the gate).
const flatJob = (stageName, prevStageName = null) => ({ stageName, prevStageName });

/** Mock RF: one search page of `rows`, and per-candidate movement responses. */
function mockRF(rows, movementsByCandidate = {}) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/candidate/search')) {
      return new Response(JSON.stringify({ data: rows }), { status: 200 });
    }
    if (url.includes('/candidate/activities/stage-movement/list')) {
      const id = Number(new URL(url).searchParams.get('id'));
      return new Response(
        JSON.stringify({ data: { jobs: movementsByCandidate[id] ?? [] } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

describe('passesSubmissionGate', () => {
  it('keeps a candidate with any submitted-territory job', () => {
    expect(passesSubmissionGate([flatJob('Sourced'), flatJob('CV Sent')])).toBe(true);
    expect(passesSubmissionGate([flatJob('Offer')])).toBe(true);
  });

  it('drops a candidate with only pre-submission jobs', () => {
    expect(passesSubmissionGate([flatJob('Sourced'), flatJob('Shortlist')])).toBe(false);
    expect(passesSubmissionGate([])).toBe(false);
    expect(passesSubmissionGate([flatJob(null), flatJob('')])).toBe(false);
  });

  it('judges a disqualified job by the previous stage; unknown previous keeps', () => {
    expect(passesSubmissionGate([flatJob('Disqualified', 'CV Sent')])).toBe(true);
    expect(passesSubmissionGate([flatJob('Disqualified', 'Sourced')])).toBe(false);
    expect(passesSubmissionGate([flatJob('Disqualified')])).toBe(true); // unknown prev → keep
    expect(passesSubmissionGate([flatJob('Disqualified', '')])).toBe(true);
  });
});

describe('POST /admin/stage-stats/reconcile', () => {
  it('401s a missing or wrong token (fail closed)', async () => {
    for (const token of [null, 'wrong']) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(reconcileRequest(token), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(401);
    }
  });

  it('gates the walk: only submitted-territory candidates get a detail fetch', async () => {
    mockRF(
      [
        searchRow(101, [job('CV Sent')]), // gated in
        searchRow(102, [job('Sourced')]), // gated out
        searchRow(103, [job('Disqualified', '1st Interview')]), // DQ from submitted → in
      ],
      {
        101: [
          {
            id: 11,
            transitions: [
              { from: 'Sourced', to: 'CV Sent', entered: '2026-06-08T08:45:00+0000', stage_moved_by: { id: 900005 } },
            ],
          },
        ],
        103: [],
      },
    );

    const ctx = createExecutionContext();
    const res = await worker.fetch(reconcileRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, candidates: 3, gated: 2, stored: 1, failed: 0 });

    const detailCalls = globalThis.fetch.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].url))
      .filter((u) => u.includes('stage-movement'));
    expect(detailCalls).toHaveLength(2);
    expect(detailCalls.some((u) => u.includes('id=102'))).toBe(false);

    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('reconcile');
  });

  it('windows the sweep from the PREVIOUS London Monday (cross-boundary healing)', async () => {
    mockRF([searchRow(101, [job('CV Sent')])], { 101: [] });
    const ctx = createExecutionContext();
    const res = await worker.fetch(reconcileRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const detailUrl = globalThis.fetch.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].url))
      .find((u) => u.includes('stage-movement'));
    const after = new URL(detailUrl).searchParams.get('after');
    // previous Monday is 7–14 days back, never less
    const ageDays = (Date.now() - Date.parse(after)) / 86_400_000;
    expect(ageDays).toBeGreaterThanOrEqual(7);
    expect(ageDays).toBeLessThan(15);
  });

  it('a failing candidate is skipped, the sweep continues', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/candidate/search')) {
        return new Response(
          JSON.stringify({ data: [searchRow(101, [job('CV Sent')]), searchRow(102, [job('Offer')])] }),
          { status: 200 },
        );
      }
      const id = Number(new URL(url).searchParams.get('id'));
      if (id === 101) return new Response('nope', { status: 400 });
      return new Response(
        JSON.stringify({
          data: {
            jobs: [
              {
                id: 12,
                transitions: [
                  { from: 'Sourced', to: 'CV Sent', entered: '2026-06-08T09:00:00+0000', stage_moved_by: { id: 900002 } },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(reconcileRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, gated: 2, stored: 1, failed: 1 });
  });
});
