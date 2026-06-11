import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src';
import { applyStageEventsMigration } from '../helpers/stage-events-migrate.js';
import { DEFAULT_PIPELINE, pipelineResponse } from '../helpers/rf-pipeline-mock.js';
import { passesSubmissionGate, newIngestContext } from '../../src/stage-stats.js';

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
const job = (jobId, stageName, prevStageName = null) => ({
  job_id: jobId,
  stage_name: stageName,
  previous_stage_details: prevStageName === null ? undefined : { prev_stage_name: prevStageName },
});
// Flattened shape (what searchActiveCandidates hands to the gate).
const flatJob = (jobId, stageName, prevStageName = null) => ({ jobId, stageName, prevStageName });

/**
 * Mock RF: one search page of `rows`, per-candidate movement responses, and
 * per-job pipelines (default pipeline when unmapped).
 */
function mockRF(rows, movementsByCandidate = {}, pipelinesByJob = {}) {
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
    if (url.includes('/job/pipeline')) {
      const jobId = Number(new URL(url).searchParams.get('job_id'));
      const pipeline = pipelinesByJob[jobId];
      if (pipeline instanceof Response) return pipeline;
      return pipelineResponse(pipeline ?? DEFAULT_PIPELINE);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

describe('passesSubmissionGate (positional, per job pipeline)', () => {
  const gate = (jobs) => passesSubmissionGate(env, jobs, newIngestContext());

  it('keeps a candidate with any job at/after that job’s CV Sent landmark', async () => {
    mockRF([], {}, {});
    expect(await gate([flatJob(11, 'Sourced'), flatJob(12, 'CV Sent')])).toBe(true);
    expect(await gate([flatJob(13, 'Offer')])).toBe(true);
  });

  it('drops a candidate with only pre-landmark jobs', async () => {
    mockRF([], {}, {});
    expect(await gate([flatJob(11, 'Sourced'), flatJob(12, 'Shortlist')])).toBe(false);
    expect(await gate([])).toBe(false);
    expect(await gate([flatJob(11, null), flatJob(12, '')])).toBe(false);
  });

  it('judges a custom stage by its position in THAT job’s pipeline', async () => {
    mockRF([], {}, { 21: ['Sourced', 'Client Review', 'CV Sent', 'Offer', 'Disqualified'] });
    // 'Client Review' is pre-landmark in job 21 — the old denylist kept it.
    expect(await gate([flatJob(21, 'Client Review')])).toBe(false);
  });

  it('judges a disqualified job by the previous stage; unknown previous keeps', async () => {
    mockRF([], {}, {});
    expect(await gate([flatJob(11, 'Disqualified', 'CV Sent')])).toBe(true);
    expect(await gate([flatJob(11, 'Disqualified', 'Sourced')])).toBe(false);
    expect(await gate([flatJob(11, 'Disqualified')])).toBe(true); // unknown prev → keep
    expect(await gate([flatJob(11, 'Disqualified', '')])).toBe(true);
  });

  it('a job whose pipeline lacks the landmark never qualifies', async () => {
    mockRF([], {}, { 31: ['Sourced', 'Screening', 'Hired'] });
    expect(await gate([flatJob(31, 'Hired')])).toBe(false);
  });

  it('errs toward keeping: unknown stage or transient pipeline failure', async () => {
    mockRF([], {}, {});
    expect(await gate([flatJob(11, 'Some Ghost Stage')])).toBe(true);

    mockRF([], {}, { 41: new Response('rf down', { status: 503 }) });
    expect(await gate([flatJob(41, 'Sourced')])).toBe(true);
  });

  it('skips a deleted job (pipeline 404)', async () => {
    mockRF([], {}, { 51: new Response('gone', { status: 404 }) });
    expect(await gate([flatJob(51, 'CV Sent')])).toBe(false);
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
        searchRow(101, [job(11, 'CV Sent')]), // gated in
        searchRow(102, [job(12, 'Sourced')]), // gated out
        searchRow(103, [job(13, 'Disqualified', '1st Interview')]), // DQ from submitted → in
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

    const calls = globalThis.fetch.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : c[0].url));
    const detailCalls = calls.filter((u) => u.includes('stage-movement'));
    expect(detailCalls).toHaveLength(2);
    expect(detailCalls.some((u) => u.includes('id=102'))).toBe(false);

    // pipelines memoised per sweep: one fetch per distinct job id
    const pipelineCalls = calls.filter((u) => u.includes('/job/pipeline'));
    expect(pipelineCalls).toHaveLength(new Set(pipelineCalls).size);

    const rows = (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events').all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('reconcile');
  });

  it('windows the sweep from the PREVIOUS London Monday (cross-boundary healing)', async () => {
    mockRF([searchRow(101, [job(11, 'CV Sent')])], { 101: [] });
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
          JSON.stringify({ data: [searchRow(101, [job(11, 'CV Sent')]), searchRow(102, [job(12, 'Offer')])] }),
          { status: 200 },
        );
      }
      if (url.includes('/job/pipeline')) return pipelineResponse();
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
