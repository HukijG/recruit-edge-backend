import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/sync-worker.js';
import { applyMigration } from './helpers/migrate.js';

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
});

const samplePayload = {
  call_id: 'c-abc-123',
  target: { id: '8000000000000001' },
  contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF42' },
  date_started: 1717248000000,
  total_duration: 180000,
  direction: 'outbound',
};

function makeRequest(path, { method = 'POST', body, token = env.INTERNAL_SECRET } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token !== null) headers.set('X-Internal-Token', token);
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  return new Request(`http://internal${path}`, init);
}

describe('POST /internal/calls/upsert', () => {
  it('inserts a row from a hangup-shaped payload', async () => {
    const res = await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: JSON.stringify(samplePayload) }),
      env,
      {},
    );
    expect(res.status).toBe(200);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id, rf_candidate_id, target_dialpad_id FROM calls').all();
    expect(results[0]).toEqual({
      call_id: 'c-abc-123', rf_candidate_id: 42, target_dialpad_id: '8000000000000001',
    });
  });

  it('is idempotent on duplicate fire', async () => {
    await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: JSON.stringify(samplePayload) }),
      env,
      {},
    );
    await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: JSON.stringify({ ...samplePayload, total_duration: 999 }) }),
      env,
      {},
    );
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT duration_ms FROM calls WHERE call_id = ?').bind('c-abc-123').all();
    expect(results[0].duration_ms).toBe(180000); // first write wins (INSERT-OR-IGNORE)
  });

  it('rejects malformed payloads with 400', async () => {
    const res = await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: JSON.stringify({}) }),
      env,
      {},
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-POST with 405', async () => {
    const res = await worker.fetch(
      makeRequest('/internal/calls/upsert', { method: 'GET', body: undefined }),
      env,
      {},
    );
    expect(res.status).toBe(405);
  });

  it('rejects invalid JSON body with 400', async () => {
    const res = await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: 'not-json{' }),
      env,
      {},
    );
    expect(res.status).toBe(400);
  });

  it('writes rf_candidate_id as NULL when payload has no contact (cold call)', async () => {
    const coldCallPayload = {
      call_id: 'c-cold-1',
      target: { id: '8000000000000001' },
      date_started: 1717248000000,
      total_duration: 60_000,
      direction: 'inbound',
    };
    const res = await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: JSON.stringify(coldCallPayload) }),
      env,
      {},
    );
    expect(res.status).toBe(200);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id, rf_candidate_id FROM calls WHERE call_id = ?')
      .bind('c-cold-1').all();
    expect(results[0].rf_candidate_id).toBeNull();
  });

  it('returns 401 without X-Internal-Token', async () => {
    const res = await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: JSON.stringify(samplePayload), token: null }),
      env,
      {},
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong X-Internal-Token', async () => {
    const res = await worker.fetch(
      makeRequest('/internal/calls/upsert', { body: JSON.stringify(samplePayload), token: 'wrong-token' }),
      env,
      {},
    );
    expect(res.status).toBe(401);
  });
});
