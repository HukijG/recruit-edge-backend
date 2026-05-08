import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

const insertJob = async (id, name = 'Job ' + id, client = 'Acme') => {
  await env.RF_MCP_CACHE
    .prepare(`INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
              VALUES (?, ?, ?, ?, 1, ?)`)
    .bind(id, JSON.stringify({ id, name }), name, client, new Date().toISOString())
    .run();
};

const insertCandidate = async (id, name, body = {}) => {
  await env.RF_MCP_CACHE
    .prepare(`INSERT INTO candidates (id, body, name, linkedin_profile, cached_at)
              VALUES (?, ?, ?, ?, ?)`)
    .bind(
      id,
      JSON.stringify({ id, name, ...body }),
      name,
      body.linkedin_profile ?? null,
      new Date().toISOString(),
    )
    .run();
};

const insertPipeline = async (jobId, summary, stageCandidates) => {
  await env.RF_MCP_CACHE
    .prepare(`INSERT OR REPLACE INTO job_pipelines (job_id, summary_json, stage_candidates_json, fetched_at)
              VALUES (?, ?, ?, ?)`)
    .bind(jobId, JSON.stringify(summary), JSON.stringify(stageCandidates), new Date().toISOString())
    .run();
};

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM job_pipelines');
});

const call = (b) =>
  worker.fetch(
    new Request('http://x/mcp/job-candidates-filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify({ consultantFirstName: 'Joel', ...b }),
    }),
    env,
    createExecutionContext(),
  );

describe('/mcp/job-candidates-filter', () => {
  it('reads from job_pipelines + hydrates from candidates', async () => {
    await insertJob(100, 'Eng');
    await insertCandidate(1, 'A', { linkedin_profile: 'a-slug' });
    await insertCandidate(2, 'B', { linkedin_profile: 'b-slug' });
    await insertPipeline(100, [
      { id: 1, name: 'Sourced', count: 2 },
    ], { Sourced: [1, 2] });
    const r = await call({ job: 100 });
    const body = await r.json();
    expect(body.total).toBe(2);
    expect(body.matched.map((m) => m.id).sort()).toEqual([1, 2]);
    // Each match has a full LinkedIn URL.
    expect(body.matched[0].linkedin_profile).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
  });

  it('default fields = id, name, linkedin_profile only — no stage_name on each row', async () => {
    await insertJob(100);
    await insertCandidate(1, 'A', { linkedin_profile: 'a-slug' });
    await insertPipeline(100, [{ id: 1, name: 'Sourced', count: 1 }], { Sourced: [1] });
    const r = await call({ job: 100 });
    const body = await r.json();
    const m = body.matched[0];
    expect(Object.keys(m).sort()).toEqual(['id', 'linkedin_profile', 'name']);
  });

  it('cold cache returns 200 + warning + empty matched', async () => {
    await insertJob(100);
    const r = await call({ job: 100 });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.matched).toEqual([]);
    expect(body.total).toBe(0);
    expect(body._meta?.warnings?.[0]).toMatch(/cache.*15-min/i);
  });

  it('stage filter exact', async () => {
    await insertJob(100);
    await insertCandidate(1, 'A');
    await insertCandidate(2, 'B');
    await insertPipeline(100,
      [{ id: 1, name: 'Sourced', count: 1 }, { id: 2, name: 'Replied', count: 1 }],
      { Sourced: [1], Replied: [2] }
    );
    const r = await call({ job: 100, stage: 'Replied' });
    const body = await r.json();
    expect(body.matched.map((m) => m.id)).toEqual([2]);
  });

  it('stage filter fuzzy match', async () => {
    await insertJob(100);
    await insertCandidate(1, 'A');
    await insertPipeline(100,
      [{ id: 1, name: 'Sourced', count: 1 }],
      { Sourced: [1] }
    );
    const r = await call({ job: 100, stage: 'sourced' });
    const body = await r.json();
    expect(body.matched.map((m) => m.id)).toEqual([1]);
  });

  it('stage ambiguity returns 200 disambiguation', async () => {
    await insertJob(100);
    await insertPipeline(100,
      [{ id: 1, name: '1st Interview', count: 0 }, { id: 2, name: '2nd Interview', count: 0 }],
      {}
    );
    const r = await call({ job: 100, stage: 'interview' });
    const body = await r.json();
    expect(body.needs_disambiguation).toBe(true);
    expect(body.kind).toBe('stage');
  });

  it('Disqualified excluded by default', async () => {
    await insertJob(100);
    await insertCandidate(1, 'A');
    await insertCandidate(2, 'DQ');
    await insertPipeline(100,
      [{ id: 1, name: 'Sourced', count: 1 }, { id: 2, name: 'Disqualified', count: 1 }],
      { Sourced: [1], Disqualified: [2] }
    );
    const r = await call({ job: 100 });
    const body = await r.json();
    expect(body.matched.map((m) => m.id)).toEqual([1]);
  });

  it('include_disqualified opt-in', async () => {
    await insertJob(100);
    await insertCandidate(1, 'A');
    await insertCandidate(2, 'DQ');
    await insertPipeline(100,
      [{ id: 1, name: 'Sourced', count: 1 }, { id: 2, name: 'Disqualified', count: 1 }],
      { Sourced: [1], Disqualified: [2] }
    );
    const r = await call({ job: 100, include_disqualified: true });
    const body = await r.json();
    expect(body.matched.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  it('limit truncates and reports total', async () => {
    await insertJob(100);
    for (let i = 1; i <= 5; i++) {
      await insertCandidate(i, `C${i}`);
    }
    await insertPipeline(100,
      [{ id: 1, name: 'Sourced', count: 5 }],
      { Sourced: [1, 2, 3, 4, 5] }
    );
    const r = await call({ job: 100, limit: 2 });
    const body = await r.json();
    expect(body.matched.length).toBe(2);
    expect(body.total).toBe(5);
    expect(body.truncated).toBe(true);
  });

  it('job_id short-circuit', async () => {
    await insertJob(100);
    await insertPipeline(100, [{ id: 1, name: 'Sourced', count: 0 }], { Sourced: [] });
    const r = await call({ job_id: 100 });
    const body = await r.json();
    expect(body.job.id).toBe(100);
  });

  it('returns top-level job block with id, name, client_company_name', async () => {
    await insertJob(100, 'Eng Lead', 'Acme.io');
    await insertPipeline(100, [{ id: 1, name: 'Sourced', count: 0 }], { Sourced: [] });
    const r = await call({ job: 100 });
    const body = await r.json();
    expect(body.job).toEqual({ id: 100, name: 'Eng Lead', client_company_name: 'Acme.io' });
  });

  it('fields extends defaults', async () => {
    await insertJob(100);
    await insertCandidate(1, 'A', { linkedin_profile: 'a', current_organization: 'Acme' });
    await insertPipeline(100, [{ id: 1, name: 'Sourced', count: 1 }], { Sourced: [1] });
    const r = await call({ job: 100, fields: ['company'] });
    const body = await r.json();
    const m = body.matched[0];
    expect(m.id).toBe(1);
    expect(m.linkedin_profile).toBe('https://www.linkedin.com/in/a');
    expect(m.current_organization).toBe('Acme');
  });
});
