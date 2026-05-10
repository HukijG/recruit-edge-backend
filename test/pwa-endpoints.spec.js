/**
 * Tests for the two mobile-PWA endpoints:
 *   - POST /my-sourcing-jobs    → open jobs filtered to consultant on hiring
 *                                 team as Recruiter + status === "Sourcing"
 *   - POST /job-pipeline        → Sourced-stage candidates for a job, sorted
 *                                 by added_time ASC, minimal { rfId, linkedinUrl }
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import worker from '../src';

beforeEach(async () => {
  await applyUsersMigration(env);
  _resetCacheForTests();
});

const originalFetch = globalThis.fetch;

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, opts });
    for (const route of routes) {
      if (urlStr.includes(route.match)) {
        if (typeof route.response === 'function') return route.response(urlStr, opts);
        return new Response(JSON.stringify(route.response), {
          status: route.status || 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'unmocked' }), { status: 500 });
  };
  return calls;
}

function findCalls(calls, pattern) {
  return calls.filter(c => c.url.includes(pattern));
}

const JOEL_RF_USER_ID = 900001;
const ALICE_RF_USER_ID = 900002;

// Helpers to build job + candidate fixtures matching RF's actual response shapes.
function buildJob(overrides = {}) {
  return {
    id: 1,
    name: 'Test Job',
    title: 'Test Job',
    company: { name: 'Acme Inc' },
    is_open: true,
    job_status: { id: 1, name: 'Sourcing' },
    hiring_team: [{ user_id: JOEL_RF_USER_ID, role: 'Recruiter', name: 'Joel Haines' }],
    ...overrides,
  };
}

/**
 * Builds a candidate matching RF's real /candidate/search shape:
 *   - Top-level `added_time` = when the candidate record was first created in RF
 *     (the creation date — irrelevant for the pipeline view).
 *   - `jobs[].added_time` = when the candidate was added to that specific job
 *     (the job-link creation date — what the pipeline view actually sorts on).
 *
 * The default jobs[0].job_id is 980 to match the default pipelineReq below.
 *
 * Override `jobAddedTime` to set jobs[0].added_time without rebuilding the
 * whole jobs array. To exercise multi-job candidates, override `jobs` directly.
 */
function buildCandidate({ jobAddedTime, ...overrides } = {}) {
  return {
    id: 12345,
    first_name: 'Tony',
    last_name: 'Doe',
    name: 'Jane Doe',
    linkedin_profile: 'jane-doe-000000000',
    added_time: '2024-01-15T09:00:00+0000',
    jobs: [{
      job_id: 980,
      stage_name: 'Sourced',
      stage_id: 1,
      added_time: jobAddedTime || '2026-04-30T15:08:04+0000',
    }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// /my-sourcing-jobs
// ---------------------------------------------------------------------------

describe('/my-sourcing-jobs', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  function jobsReq(consultantFirstName = 'Joel') {
    return new Request('http://example.com/my-sourcing-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName }),
    });
  }

  it('returns 401 without X-Extension-Token', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/my-sourcing-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('returns 400 when consultantFirstName missing', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/my-sourcing-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({}),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });

  it('returns 403 when consultant not in registry', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(jobsReq('Nobody'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
  });

  it('returns only jobs where consultant is on hiring team as Recruiter AND status is Sourcing', async () => {
    mockFetch([
      {
        match: '/job/list',
        response: [
          buildJob({ id: 1, name: 'Match 1' }),
          buildJob({ id: 2, name: 'Wrong status', job_status: { id: 2, name: 'Client Interview' } }),
          buildJob({ id: 3, name: 'Wrong recruiter', hiring_team: [{ user_id: ALICE_RF_USER_ID, role: 'Recruiter', name: 'Alice' }] }),
          buildJob({ id: 4, name: 'Joel as Hiring Manager', hiring_team: [{ user_id: JOEL_RF_USER_ID, role: 'Hiring Manager', name: 'Joel' }] }),
          buildJob({ id: 5, name: 'No hiring team', hiring_team: [] }),
          buildJob({ id: 6, name: 'Match 2', company: { name: 'Other Co' } }),
        ],
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(jobsReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.jobs).toHaveLength(2);
    expect(json.jobs.map(j => j.id).sort()).toEqual([1, 6]);
    expect(json.jobs[0]).toEqual({ id: 1, name: 'Match 1', company: 'Acme Inc' });
  });

  it('case-insensitive match on job_status name and hiring_team role', async () => {
    mockFetch([
      {
        match: '/job/list',
        response: [
          buildJob({ id: 7, job_status: { id: 1, name: 'sourcing' }, hiring_team: [{ user_id: JOEL_RF_USER_ID, role: 'recruiter' }] }),
          buildJob({ id: 8, job_status: { id: 1, name: 'SOURCING' }, hiring_team: [{ user_id: JOEL_RF_USER_ID, role: 'RECRUITER' }] }),
        ],
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(jobsReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.jobs.map(j => j.id).sort()).toEqual([7, 8]);
  });

  it('returns empty list when no jobs match', async () => {
    mockFetch([
      { match: '/job/list', response: [] },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(jobsReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobs: [] });
  });
});

// ---------------------------------------------------------------------------
// /job-pipeline
// ---------------------------------------------------------------------------

describe('/job-pipeline', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  function pipelineReq(body = { consultantFirstName: 'Joel', jobId: 980 }) {
    return new Request('http://example.com/job-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify(body),
    });
  }

  it('returns 401 without X-Extension-Token', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/job-pipeline', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consultantFirstName: 'Joel', jobId: 1 }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('returns 400 when jobId missing', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });

  it('returns 400 when jobId is not a valid integer', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 'not-a-number' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });

  it('returns 403 when consultant not in registry', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Nobody', jobId: 1 }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
  });

  it('POSTs /candidate/search with job and stage filters', async () => {
    const calls = mockFetch([
      {
        match: '/candidate/search',
        response: { data: [], total_items: 0 },
      },
    ]);

    const ctx = createExecutionContext();
    await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    const searchCalls = findCalls(calls, '/candidate/search');
    expect(searchCalls).toHaveLength(1);
    const body = JSON.parse(searchCalls[0].opts.body);
    expect(body.conjunction).toBe('match-all');
    expect(body.include_count).toBe(true);
    expect(body.filters).toContainEqual({ conjunction: 'in', values: [980], key: 'job' });
    expect(body.filters).toContainEqual({ conjunction: 'in', values: ['Sourced'], key: 'stage' });
  });

  it('returns rfId + linkedinUrl per candidate, sorted by per-job added_time DESC (newest first)', async () => {
    mockFetch([
      {
        match: '/candidate/search',
        response: {
          data: [
            buildCandidate({ id: 30, linkedin_profile: 'newest-profile', jobAddedTime: '2026-04-30T12:00:00+0000' }),
            buildCandidate({ id: 10, linkedin_profile: 'oldest-profile', jobAddedTime: '2026-04-15T12:00:00+0000' }),
            buildCandidate({ id: 20, linkedin_profile: 'middle-profile', jobAddedTime: '2026-04-22T12:00:00+0000' }),
          ],
          total_items: 3,
        },
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.jobId).toBe(980);
    expect(json.stage).toBe('Sourced');
    expect(json.total).toBe(3);
    expect(json.candidates).toHaveLength(3);
    expect(json.candidates.map(c => c.rfId)).toEqual([30, 20, 10]);
    expect(json.candidates[0].linkedinUrl).toBe('https://www.linkedin.com/in/newest-profile');
  });

  it('sorts by jobs[].added_time (per-job link), NOT top-level candidate added_time', async () => {
    // Realistic scenario: three candidates were all bulk-added to job 980
    // today. Their candidate records were originally created in RF on
    // wildly different dates (one in 2022, one in 2024, one today). The
    // top-level `added_time` is candidate-creation, NOT relevant to the
    // pipeline view; the per-job-link `added_time` is what determines order.
    mockFetch([
      {
        match: '/candidate/search',
        response: {
          data: [
            buildCandidate({
              id: 100,
              linkedin_profile: 'second-added',
              added_time: '2022-06-01T12:00:00+0000',         // ancient candidate
              jobs: [{ job_id: 980, stage_name: 'Sourced', added_time: '2026-05-06T13:00:00+0000' }],
            }),
            buildCandidate({
              id: 200,
              linkedin_profile: 'first-added',
              added_time: '2026-05-06T09:00:00+0000',         // brand-new candidate
              jobs: [{ job_id: 980, stage_name: 'Sourced', added_time: '2026-05-06T12:00:00+0000' }],
            }),
            buildCandidate({
              id: 300,
              linkedin_profile: 'third-added',
              added_time: '2024-03-15T08:00:00+0000',         // mid-aged candidate
              jobs: [{ job_id: 980, stage_name: 'Sourced', added_time: '2026-05-06T14:00:00+0000' }],
            }),
          ],
          total_items: 3,
        },
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    const json = await response.json();
    // Newest-first by jobs[].added_time: 300 (14:00) → 100 (13:00) → 200 (12:00).
    // Top-level added_time would give a totally different order — that's the bug.
    expect(json.candidates.map(c => c.rfId)).toEqual([300, 100, 200]);
  });

  it('picks the jobs[] entry matching queried jobId when candidate is on multiple jobs', async () => {
    mockFetch([
      {
        match: '/candidate/search',
        response: {
          data: [
            buildCandidate({
              id: 1,
              linkedin_profile: 'first',
              jobs: [
                { job_id: 100, stage_name: 'Hired',   added_time: '2025-01-01T00:00:00+0000' },
                { job_id: 980, stage_name: 'Sourced', added_time: '2026-05-06T15:00:00+0000' }, // queried job
                { job_id: 200, stage_name: 'Applied', added_time: '2024-12-31T23:59:00+0000' },
              ],
            }),
            buildCandidate({
              id: 2,
              linkedin_profile: 'second',
              jobs: [
                { job_id: 980, stage_name: 'Sourced', added_time: '2026-05-06T10:00:00+0000' }, // queried job
                { job_id: 300, stage_name: 'Sourced', added_time: '2026-05-06T20:00:00+0000' },
              ],
            }),
          ],
          total_items: 2,
        },
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    const json = await response.json();
    // Newest-first by jobs[entry where job_id===980].added_time: id 1 at 15:00, then id 2 at 10:00.
    expect(json.candidates.map(c => c.rfId)).toEqual([1, 2]);
  });

  it('filters out candidates with missing or "None" linkedin_profile', async () => {
    mockFetch([
      {
        match: '/candidate/search',
        response: {
          data: [
            buildCandidate({ id: 1, linkedin_profile: 'good-profile' }),
            buildCandidate({ id: 2, linkedin_profile: 'None' }),  // RF's literal "None" string
            buildCandidate({ id: 3, linkedin_profile: '' }),
            buildCandidate({ id: 4, linkedin_profile: null }),
          ],
          total_items: 4,
        },
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].rfId).toBe(1);
  });

  it('normalizes RF linkedin_profile slugs into full URLs', async () => {
    mockFetch([
      {
        match: '/candidate/search',
        response: {
          data: [
            // RF returns a bare slug
            buildCandidate({ id: 1, linkedin_profile: 'jane-doe-000000000' }),
            // Or sometimes a full URL
            buildCandidate({ id: 2, linkedin_profile: 'https://www.linkedin.com/in/jane-doe-123/' }),
          ],
          total_items: 2,
        },
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    const json = await response.json();
    expect(json.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ rfId: 1, linkedinUrl: 'https://www.linkedin.com/in/jane-doe-000000000' }),
      expect.objectContaining({ rfId: 2, linkedinUrl: 'https://www.linkedin.com/in/jane-doe-123' }),
    ]));
  });

  it('returns empty array when RF returns no candidates', async () => {
    mockFetch([
      { match: '/candidate/search', response: { data: [], total_items: 0 } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    const json = await response.json();
    expect(json.candidates).toEqual([]);
    expect(json.total).toBe(0);
  });

  it('returns 500 when RF /candidate/search fails', async () => {
    mockFetch([
      { match: '/candidate/search', status: 500, response: { error: 'oops' } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(pipelineReq({ consultantFirstName: 'Joel', jobId: 980 }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
  });
});
