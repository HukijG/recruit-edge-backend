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
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs_v2');
  await env.RF_MCP_CACHE.exec('DELETE FROM calls');
  await env.RF_MCP_CACHE.exec('DELETE FROM sync_state');
});

describe('/mcp/cache-status', () => {
  it('returns counts + sync state including v2 counts and the added-on cursor', async () => {
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, cached_at) VALUES (1, ?, ?, ?)'
    ).bind('{}', 'A', new Date().toISOString()).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (1, ?, null, 1, 1)'
    ).bind('A').run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms) VALUES (10, ?, ?, 1, 1)'
    ).bind('Job', 'Co').run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO calls (call_id, target_dialpad_id, date_started_ms, cached_at_ms) VALUES (?, ?, 1, 1)'
    ).bind('c1', '5357').run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO sync_state (key, value) VALUES (?, ?)'
    ).bind('last_tail_sync_at', '2026-05-07T12:00:00Z').run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO sync_state (key, value) VALUES (?, ?)'
    ).bind('last_candidates_added_cursor', '2026-05-06T00:00:00Z').run();

    const r = await worker.fetch(new Request('http://x/mcp/cache-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, createExecutionContext());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.candidates_count).toBe(1);
    expect(body.candidates_v2_count).toBe(1);
    expect(body.jobs_v2_count).toBe(1);
    expect(body.calls_count).toBe(1);
    expect(body.last_tail_sync_at).toBe('2026-05-07T12:00:00Z');
    expect(body.last_candidates_added_cursor).toBe('2026-05-06T00:00:00Z');
  });

  it('handles empty state with nulls', async () => {
    const r = await worker.fetch(new Request('http://x/mcp/cache-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, createExecutionContext());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.candidates_count).toBe(0);
    expect(body.candidates_v2_count).toBe(0);
    expect(body.last_tail_sync_at).toBeNull();
    expect(body.minutes_since_last_sync).toBeNull();
  });

  it('returns null for legacy counts when the legacy tables are dropped', async () => {
    // Simulate post-cutover-step-6: drop legacy tables; v2 counts still work.
    await env.RF_MCP_CACHE.exec('DROP TABLE candidates');
    await env.RF_MCP_CACHE.exec('DROP TABLE jobs');
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (1, ?, null, 1, 1)'
    ).bind('A').run();

    const r = await worker.fetch(new Request('http://x/mcp/cache-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, createExecutionContext());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.candidates_count).toBeNull();
    expect(body.jobs_count).toBeNull();
    expect(body.candidates_v2_count).toBe(1);
  });
});
