import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

const KV_KEYS = [
  'mcp:job-candidates:100',
  'mcp:job-candidates:200',
  'mcp:job-candidates:999',
];

const insertJob = async (id, name = 'Job ' + id) => {
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, JSON.stringify({ id, name }), name, 'Acme', new Date().toISOString())
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
    new Request('http://x/mcp/job-candidates-filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify(b),
    }),
    env,
    createExecutionContext(),
  );

describe('/mcp/job-candidates-filter', () => {
  it('returns KV-cached list', async () => {
    const snap = {
      job: { id: 100, name: 'Eng Lead' },
      total: 2,
      matched: [
        { id: 1, name: 'Alice', stage_name: 'Sourced', stage_moved: 't' },
        { id: 2, name: 'Bob', stage_name: 'CV Sent', stage_moved: 't' },
      ],
    };
    await env.SYNC_STATE.put('mcp:job-candidates:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
    expect(b.total).toBe(2);
    expect(b.matched).toHaveLength(2);
    expect(b.matched[0].id).toBe(1);
  });

  it('falls back to D1 + writes KV', async () => {
    await insertJob(100, 'Eng Lead');
    await insertCandidate(1, 'Alice');
    await insertCandidate(2, 'Bob');
    await linkJob(1, 100, 'Sourced');
    await linkJob(2, 100, 'CV Sent');

    expect(await env.SYNC_STATE.get('mcp:job-candidates:100')).toBeNull();
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.total).toBe(2);
    expect(b.matched.map((m) => m.id).sort()).toEqual([1, 2]);

    const written = await env.SYNC_STATE.get('mcp:job-candidates:100');
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written);
    expect(parsed.total).toBe(2);
    expect(parsed.matched).toHaveLength(2);
  });

  it('filters by stage', async () => {
    const snap = {
      job: { id: 100, name: 'J' },
      total: 3,
      matched: [
        { id: 1, name: 'A', stage_name: 'Sourced', stage_moved: 't' },
        { id: 2, name: 'B', stage_name: 'CV Sent', stage_moved: 't' },
        { id: 3, name: 'C', stage_name: 'CV Sent', stage_moved: 't' },
      ],
    };
    await env.SYNC_STATE.put('mcp:job-candidates:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'CV Sent' });
    const b = await r.json();
    expect(b.matched).toHaveLength(2);
    expect(b.matched.map((m) => m.id).sort()).toEqual([2, 3]);
    // total reflects the snapshot total (pre-filter), not the filtered count.
    expect(b.total).toBe(3);
  });

  it('honours limit + sets truncated:true when exceeded', async () => {
    const matched = [];
    for (let i = 1; i <= 5; i++) {
      matched.push({ id: i, name: 'C' + i, stage_name: 'Sourced', stage_moved: 't' });
    }
    const snap = { job: { id: 100, name: 'J' }, total: 5, matched };
    await env.SYNC_STATE.put('mcp:job-candidates:100', JSON.stringify(snap));

    const r = await call({ consultantFirstName: 'Joel', job: 100, limit: 2 });
    const b = await r.json();
    expect(b.matched).toHaveLength(2);
    expect(b.truncated).toBe(true);

    // No truncation when limit fits.
    const r2 = await call({ consultantFirstName: 'Joel', job: 100, limit: 10 });
    const b2 = await r2.json();
    expect(b2.matched).toHaveLength(5);
    expect(b2.truncated).toBeUndefined();
  });

  it('returns 404 for unknown job', async () => {
    const r = await call({ consultantFirstName: 'Joel', job: 999 });
    expect(r.status).toBe(404);
  });
});
