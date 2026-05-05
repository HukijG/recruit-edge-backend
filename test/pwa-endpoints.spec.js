/**
 * Tests for the two mobile-PWA endpoints:
 *   - POST /my-sourcing-jobs    → open jobs filtered to consultant on hiring
 *                                 team as Recruiter + status === "Sourcing"
 *   - POST /job-pipeline        → Sourced-stage candidates for a job, sorted
 *                                 by added_time ASC, minimal { rfId, linkedinUrl }
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import worker from '../src';

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

function buildCandidate(overrides = {}) {
  return {
    id: 12345,
    first_name: 'Tony',
    last_name: 'Doe',
    name: 'Jane Doe',
    linkedin_profile: 'jane-doe-000000000',
    added_time: '2026-04-30T15:08:04+0000',
    jobs: [{ job_id: 1, stage_name: 'Sourced', stage_id: 1 }],
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

  it('returns rfId + linkedinUrl per candidate, sorted by added_time ASC', async () => {
    mockFetch([
      {
        match: '/candidate/search',
        response: {
          data: [
            buildCandidate({ id: 30, linkedin_profile: 'newest-profile', added_time: '2026-04-30T12:00:00+0000' }),
            buildCandidate({ id: 10, linkedin_profile: 'oldest-profile', added_time: '2026-04-15T12:00:00+0000' }),
            buildCandidate({ id: 20, linkedin_profile: 'middle-profile', added_time: '2026-04-22T12:00:00+0000' }),
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
    expect(json.candidates.map(c => c.rfId)).toEqual([10, 20, 30]);
    expect(json.candidates[0].linkedinUrl).toBe('https://www.linkedin.com/in/oldest-profile');
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
