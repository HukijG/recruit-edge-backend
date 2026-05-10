import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-add-note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  resetSnapshot();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
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

describe('/mcp/candidate-add-note', () => {
  it('happy path: numeric candidate + plain markdown → posts HTML, returns ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 555 }), { status: 200 }),
    );

    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      note: 'spoke to him about the SE role',
    });

    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.note).toMatchObject({
      id: 555,
      candidate_id: 42,
      candidate_name: 'Test Candidate',
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = globalThis.fetch.mock.calls[0];
    expect(String(calledUrl)).toContain('/candidate/notes/add');
    const sent = JSON.parse(calledOpts.body);
    expect(sent.id).toBe(42);
    expect(sent.created_by).toBe(900001); // Joel's rfUserId from the test users migration
    expect(sent.mentions).toEqual([]);
    expect(sent.value).toContain('spoke to him about the SE role');
    // marked wraps plain prose in <p>
    expect(sent.value).toMatch(/^<p>/);
  });

  it('rejects when note is missing (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('note is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects when note is whitespace-only (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      note: '   \n  ',
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('note is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects when candidate is missing (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      note: 'a perfectly valid note body',
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('candidate is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown candidate id', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 9999,
      note: 'whatever',
    });
    expect(r.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
