import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
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
    .prepare(`INSERT INTO candidates (id, body, name, linkedin_profile, current_organization, cached_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      JSON.stringify({ id, name, ...body }),
      name,
      body.linkedin_profile ?? null,
      body.current_organization ?? null,
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

const STANDARD_SUMMARY = [
  { id: 1, name: 'Sourced',         count: 2 },
  { id: 2, name: 'Replied',         count: 1 },
  { id: 3, name: 'Call Booked',     count: 0 },
  { id: 4, name: 'Shortlist',       count: 0 },
  { id: 5, name: 'CV Sent',         count: 1 },
  { id: 6, name: '1st Interview',   count: 0 },
  { id: 7, name: 'Final Interview', count: 0 },
  { id: 8, name: 'Offer',           count: 0 },
  { id: 9, name: 'Hired',           count: 0 },
  { id: 10, name: 'Disqualified',   count: 1 },
];

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM job_pipelines');
});

const call = (b) => worker.fetch(
  new Request('http://x/mcp/job-pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
    body: JSON.stringify({ consultantFirstName: 'Joel', ...b }),
  }),
  env,
  createExecutionContext(),
);

describe('/mcp/job-pipeline', () => {
  describe('default range (CV Sent → end of pipeline)', () => {
    it('returns CV Sent through Hired in canonical order, excludes Sourced/Replied', async () => {
      await insertJob(984, 'Sales Engineer', 'Eon.io');
      await insertCandidate(7, 'X', { linkedin_profile: 'x-slug' });
      await insertPipeline(984, STANDARD_SUMMARY, { Sourced: [1, 2], Replied: [3], 'CV Sent': [7] });
      const r = await call({ job: 984 });
      const body = await r.json();
      expect(body.job).toEqual({ id: 984, name: 'Sales Engineer', client_company_name: 'Eon.io' });
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual([
        'CV Sent', '1st Interview', 'Final Interview', 'Offer', 'Hired',
      ]);
      expect(Object.keys(body.stages)).toEqual([
        'CV Sent', '1st Interview', 'Final Interview', 'Offer', 'Hired',
      ]);
      expect(body.stages['CV Sent']).toEqual([
        { id: 7, name: 'X', linkedin_profile: 'https://www.linkedin.com/in/x-slug' },
      ]);
      expect(body.stages['1st Interview']).toEqual([]);
    });
  });

  describe('submitted: true', () => {
    it('exact match on "CV Sent" — no fuzzy', async () => {
      await insertJob(984);
      await insertPipeline(984, STANDARD_SUMMARY, {});
      const r = await call({ job: 984, submitted: true });
      const body = await r.json();
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual([
        'CV Sent', '1st Interview', 'Final Interview', 'Offer', 'Hired',
      ]);
    });

    it('emits a warning + returns full pipeline when CV Sent is missing', async () => {
      await insertJob(984);
      const customSummary = [
        { id: 1, name: 'Sourced',  count: 0 },
        { id: 2, name: 'Reviewed', count: 0 },
        { id: 3, name: 'Hired',    count: 0 },
      ];
      await insertPipeline(984, customSummary, {});
      const r = await call({ job: 984, submitted: true });
      const body = await r.json();
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual(['Sourced', 'Reviewed', 'Hired']);
      expect(body._meta?.warnings?.[0]).toMatch(/no 'CV Sent' stage/i);
    });
  });

  describe('stage filter (single)', () => {
    it('exact match', async () => {
      await insertJob(984);
      await insertCandidate(11, 'A', { linkedin_profile: 'a' });
      await insertPipeline(984, STANDARD_SUMMARY, { Replied: [11] });
      const r = await call({ job: 984, stage: 'Replied' });
      const body = await r.json();
      expect(body.stage_breakdown).toEqual([{ stage_name: 'Replied', count: 1 }]);
      expect(body.stages.Replied[0].id).toBe(11);
    });

    it('fuzzy match — "replied" → "Replied"', async () => {
      await insertJob(984);
      await insertCandidate(11, 'A');
      await insertPipeline(984, STANDARD_SUMMARY, { Replied: [11] });
      const r = await call({ job: 984, stage: 'replied' });
      const body = await r.json();
      expect(body.stage_breakdown).toEqual([{ stage_name: 'Replied', count: 1 }]);
    });

    it('ambiguity returns 200 disambiguation envelope', async () => {
      await insertJob(984);
      const ambiguousSummary = [
        { id: 1, name: '1st Interview', count: 0 },
        { id: 2, name: '2nd Interview', count: 0 },
      ];
      await insertPipeline(984, ambiguousSummary, {});
      const r = await call({ job: 984, stage: 'interview' });
      const body = await r.json();
      expect(body.needs_disambiguation).toBe(true);
      expect(body.kind).toBe('stage');
    });
  });

  describe('from / to range', () => {
    it('inclusive on both ends, in canonical order', async () => {
      await insertJob(984);
      await insertPipeline(984, STANDARD_SUMMARY, {});
      const r = await call({ job: 984, from: 'Replied', to: 'Shortlist' });
      const body = await r.json();
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual([
        'Replied', 'Call Booked', 'Shortlist',
      ]);
    });
  });

  describe('include_disqualified', () => {
    it('omitted by default', async () => {
      await insertJob(984);
      await insertCandidate(99, 'DQ');
      await insertPipeline(984, STANDARD_SUMMARY, { 'CV Sent': [], Disqualified: [99] });
      const r = await call({ job: 984 });
      const body = await r.json();
      expect(Object.keys(body.stages)).not.toContain('Disqualified');
    });

    it('included when flag set, regardless of default range', async () => {
      await insertJob(984);
      await insertCandidate(99, 'DQ');
      await insertPipeline(984, STANDARD_SUMMARY, { 'CV Sent': [], Disqualified: [99] });
      const r = await call({ job: 984, include_disqualified: true });
      const body = await r.json();
      expect(Object.keys(body.stages)).toContain('Disqualified');
    });
  });

  describe('cold cache', () => {
    it('returns 200 + warning when no row in job_pipelines', async () => {
      await insertJob(984);
      const r = await call({ job: 984 });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.stage_breakdown).toEqual([]);
      expect(body.stages).toEqual({});
      expect(body._meta?.warnings?.[0]).toMatch(/cache.*15-min/i);
    });
  });

  describe('fields param', () => {
    it('extends defaults — does not replace them', async () => {
      await insertJob(984);
      await insertCandidate(7, 'X', { linkedin_profile: 'x', current_organization: 'Acme', current_title: 'CTO' });
      await insertPipeline(984, STANDARD_SUMMARY, { 'CV Sent': [7] });
      const r = await call({ job: 984, fields: ['title'] });
      const body = await r.json();
      const c = body.stages['CV Sent'][0];
      expect(c.id).toBe(7);
      expect(c.name).toBe('X');
      expect(c.linkedin_profile).toBe('https://www.linkedin.com/in/x');
      expect(c.current_title).toBe('CTO');
    });

    it('drops unknown field names silently — no _meta on a clean call', async () => {
      await insertJob(984);
      await insertCandidate(7, 'X');
      await insertPipeline(984, STANDARD_SUMMARY, { 'CV Sent': [7] });
      const r = await call({ job: 984, fields: ['totally_unknown_xyz'] });
      const body = await r.json();
      expect(body._meta).toBeUndefined();
    });
  });

  describe('job_id short-circuit', () => {
    it('numeric job_id bypasses fuzzy', async () => {
      await insertJob(984);
      await insertPipeline(984, STANDARD_SUMMARY, {});
      const r = await call({ job_id: 984, submitted: true });
      const body = await r.json();
      expect(body.job.id).toBe(984);
    });

    it('404 when job_id is unknown', async () => {
      const r = await call({ job_id: 99999 });
      expect(r.status).toBe(404);
    });
  });
});
