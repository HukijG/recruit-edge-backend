import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

const KV_KEYS = [
  'mcp:pipeline:100',
  'mcp:pipeline:200',
  'mcp:pipeline:999',
  'mcp:job-candidates:100',
  'mcp:job-candidates:200',
  'mcp:job-candidates:999',
];

const insertJob = async (id, name = 'Job ' + id, client = 'Acme') => {
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, JSON.stringify({ id, name }), name, client, new Date().toISOString())
    .run();
};

const insertCandidate = async (id, name, body = {}) => {
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO candidates (id, body, name, cached_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, JSON.stringify({ id, name, ...body }), name, new Date().toISOString())
    .run();
};

const linkJob = async (candidateId, jobId, stage, opts = {}) => {
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO candidate_jobs
        (candidate_id, job_id, stage_id, stage_name, stage_moved,
         added_to_job, added_to_job_by_id, disqualified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      candidateId,
      jobId,
      opts.stage_id ?? 1,
      stage,
      opts.stage_moved ?? '2026-05-01T00:00:00Z',
      opts.added_to_job ?? '2026-05-01T00:00:00Z',
      opts.added_to_job_by_id ?? 100,
      opts.disqualified ?? 0,
    )
    .run();
};

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  for (const k of KV_KEYS) await env.SYNC_STATE.delete(k);
});

const call = (b) =>
  worker.fetch(
    new Request('http://x/mcp/job-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify(b),
    }),
    env,
    createExecutionContext(),
  );

describe('/mcp/job-pipeline', () => {
  it('returns pre-built KV snapshot', async () => {
    const snap = {
      job: { id: 100, name: 'Eng Lead', client_company_name: 'Acme' },
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: '2026-05-01T00:00:00Z' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
    expect(b.stages).toHaveLength(1);
    expect(b.stages[0].candidates[0].id).toBe(1);
  });

  it('falls back to D1 build on KV miss + writes back to KV', async () => {
    await insertJob(100, 'Eng Lead', 'Acme');
    await insertCandidate(1, 'Alice');
    await linkJob(1, 100, 'Sourced');

    expect(await env.SYNC_STATE.get('mcp:pipeline:100')).toBeNull();
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
    expect(b.stages[0].stage_name).toBe('Sourced');
    expect(b.stages[0].candidates[0].id).toBe(1);

    // KV writeback so subsequent reads skip D1.
    const written = await env.SYNC_STATE.get('mcp:pipeline:100');
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written);
    expect(parsed.job.id).toBe(100);
    expect(parsed.stages[0].count).toBe(1);
  });

  it('narrows to a single stage when stage provided', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: 'CV Sent', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'CV Sent' });
    const b = await r.json();
    expect(b.stages).toHaveLength(1);
    expect(b.stages[0].stage_name).toBe('CV Sent');
    expect(b.stages[0].candidates[0].id).toBe(2);
  });

  it('submitted: true filters to CV Sent → Hired stages', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: 'Replied', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
        { stage_name: 'CV Sent', count: 1, candidates: [{ id: 3, name: 'C', stage_moved: 't' }] },
        { stage_name: '1st Interview', count: 1, candidates: [{ id: 4, name: 'D', stage_moved: 't' }] },
        { stage_name: 'Hired', count: 1, candidates: [{ id: 5, name: 'E', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, submitted: true });
    const b = await r.json();
    const stageNames = b.stages.map((s) => s.stage_name);
    expect(stageNames).toEqual(['CV Sent', '1st Interview', 'Hired']);
  });

  it('returns 404 for unknown job (no KV, no D1 row)', async () => {
    const r = await call({ consultantFirstName: 'Joel', job: 999 });
    expect(r.status).toBe(404);
  });

  it('numeric job id passed as string still works', async () => {
    await insertJob(100, 'Eng Lead', 'Acme');
    await insertCandidate(1, 'Alice');
    await linkJob(1, 100, 'Sourced');
    const r = await call({ consultantFirstName: 'Joel', job: '100' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
  });

  it('fuzzy job name resolves and returns the right pipeline', async () => {
    await insertJob(100, 'Enterprise AE', 'Nominal');
    await insertJob(200, 'CSM Lead', 'Other');
    await insertCandidate(1, 'Alice');
    await linkJob(1, 100, 'Sourced');
    const r = await call({ consultantFirstName: 'Joel', job: 'Enterprise AE' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
  });

  it('ambiguous fuzzy job name → needs_disambiguation kind=job', async () => {
    await insertJob(100, 'Enterprise AE', 'Acme');
    await insertJob(200, 'Enterprise AE', 'Globex');
    const r = await call({ consultantFirstName: 'Joel', job: 'Enterprise AE' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('job');
    expect(b.options).toHaveLength(2);
  });

  it('unknown fuzzy job name → 404', async () => {
    await insertJob(100, 'Enterprise AE', 'Nominal');
    const r = await call({ consultantFirstName: 'Joel', job: 'totally-not-a-real-job' });
    expect(r.status).toBe(404);
  });
});
