import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-move-stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (?, ?, ?, ?)'
  ).bind(42, JSON.stringify({
    id: 42, name: 'Jerry Smith',
    jobs: [{
      job_id: 100, job_name: 'Eng', stage_id: 1, stage_name: 'Sourced',
      disqualified: false,
      stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
    }],
  }), 'Jerry Smith', new Date().toISOString()).run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('/mcp/candidate-move-stage', () => {
  it('round-trips to RF and returns success with from/to stage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.moved.candidate_id).toBe(42);
    expect(b.moved.candidate_name).toBe('Jerry Smith');
    expect(b.moved.job_id).toBe(100);
    expect(b.moved.from_stage).toBe('Sourced');
    expect(b.moved.to_stage).toBe('Replied');

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = globalThis.fetch.mock.calls[0];
    expect(String(calledUrl)).toContain('/candidate/move-to-stage');
    expect(calledOpts.method).toBe('POST');
    const sent = JSON.parse(calledOpts.body);
    expect(sent).toMatchObject({
      id: 42,
      job_id: 100,
      stage: { id: 2, name: 'Replied' },
      user_id: 900001,  // Joel's rfUserId
    });
  });

  it('returns disambiguation when candidate has multiple non-DQ jobs and no job specified', async () => {
    await env.RF_MCP_CACHE.prepare(
      'UPDATE candidates SET body = ? WHERE id = 42'
    ).bind(JSON.stringify({
      id: 42, name: 'Jerry Smith',
      jobs: [
        { job_id: 100, job_name: 'Eng', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
        { job_id: 200, job_name: 'PM', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
      ],
    })).run();

    // No fetch mock — RF must not be called when we disambiguate.
    globalThis.fetch = vi.fn();

    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('job');
    expect(b.options).toHaveLength(2);
    expect(b.options[0]).toMatchObject({ job_id: 100, job_name: 'Eng' });
    expect(b.options[1]).toMatchObject({ job_id: 200, job_name: 'PM' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown candidate id', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 999, stage: 'Replied' });
    expect(r.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 for stage not found on job', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'NotARealStage' });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toContain('NotARealStage');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('invalidates KV snapshots after successful RF call', async () => {
    // Pre-seed both snapshots.
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify({ stale: true }));
    await env.SYNC_STATE.put('mcp:job-candidates:100', JSON.stringify({ stale: true }));

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Replied' });
    expect(r.status).toBe(200);

    expect(await env.SYNC_STATE.get('mcp:pipeline:100')).toBeNull();
    expect(await env.SYNC_STATE.get('mcp:job-candidates:100')).toBeNull();
  });
});
