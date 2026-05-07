import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-log-interview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (42, ?, ?, ?)'
  ).bind(
    JSON.stringify({ id: 42, name: 'Test Candidate', primary_email: 't@x.com' }),
    'Test Candidate',
    new Date().toISOString(),
  ).run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('/mcp/candidate-log-interview', () => {
  it('creates RF activity, returns ok + outlook_url + next_step', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.activity.id).toBe(999);
    expect(b.activity.candidate_id).toBe(42);
    expect(b.activity.kind).toBe('1st Interview');
    expect(b.next_step).toMatch(/calendar/i);
    expect(b.outlook_url).toMatch(/^https:\/\/outlook\.live\.com\/calendar/);
    // Joel's calendarMode is 'outlook' so no gcal_hint by default.
    expect(b.gcal_hint).toBeUndefined();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = globalThis.fetch.mock.calls[0];
    expect(String(calledUrl)).toContain('/custom-activity/create');
    const sent = JSON.parse(calledOpts.body);
    expect(sent).toMatchObject({
      candidate_id: 42,
      activity_type_id: 1003,
      activity_user_id: 900001,
    });
    expect(typeof sent.start_time).toBe('string');
    expect(typeof sent.end_time).toBe('string');
  });

  it('rejects without start_time (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
    });
    expect(r.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown candidate id', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 9999,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 502 if RF activity-create fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('rf went boom', { status: 500 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(502);
    const b = await r.json();
    expect(b.error).toContain('500');
  });
});
