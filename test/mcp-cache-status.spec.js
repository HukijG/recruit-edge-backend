import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import worker from '../src';

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM sync_state');
});

describe('/mcp/cache-status', () => {
  it('returns counts + sync state', async () => {
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, cached_at) VALUES (1, ?, ?, ?)'
    ).bind('{}', 'A', new Date().toISOString()).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO sync_state (key, value) VALUES (?, ?)'
    ).bind('last_tail_sync_at', '2026-05-07T12:00:00Z').run();

    const r = await worker.fetch(new Request('http://x/mcp/cache-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, createExecutionContext());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidates_count).toBe(1);
    expect(body.last_tail_sync_at).toBe('2026-05-07T12:00:00Z');
  });

  it('handles empty state with nulls', async () => {
    const r = await worker.fetch(new Request('http://x/mcp/cache-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, createExecutionContext());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidates_count).toBe(0);
    expect(body.last_tail_sync_at).toBeNull();
    expect(body.minutes_since_last_sync).toBeNull();
  });
});
