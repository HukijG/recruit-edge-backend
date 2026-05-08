import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/sync-worker.js';

const ADMIN_SECRET = 'test-admin-secret';

function makeRequest(path, { method = 'POST', token } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token !== undefined) headers.set('X-Admin-Token', token);
  return new Request(`http://localhost${path}`, { method, headers });
}

describe('/admin/full-rebuild', () => {
  it('returns 401 without X-Admin-Token header', async () => {
    const res = await worker.fetch(makeRequest('/admin/full-rebuild'), env, {});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'auth' });
  });

  it('returns 401 with wrong token', async () => {
    const res = await worker.fetch(makeRequest('/admin/full-rebuild', { token: 'wrong' }), env, {});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'auth' });
  });

  it('returns 202 with workflow_id on correct token', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: 'wf-123' });
    const testEnv = { ...env, REBUILD_WORKFLOW: { create: mockCreate } };
    const res = await worker.fetch(
      makeRequest('/admin/full-rebuild', { token: ADMIN_SECRET }),
      testEnv,
      {},
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.workflow_id).toBe('wf-123');
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0];
    expect(typeof callArg.id).toBe('string');
    expect(callArg.params.startedAt).toBeDefined();
  });

  it('returns 404 for /admin/nonsense with correct token', async () => {
    const res = await worker.fetch(
      makeRequest('/admin/nonsense', { token: ADMIN_SECRET }),
      env,
      {},
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 for /admin/nonsense with wrong token', async () => {
    const res = await worker.fetch(
      makeRequest('/admin/nonsense', { token: 'wrong' }),
      env,
      {},
    );
    expect(res.status).toBe(401);
  });

  it('passes only=jobs through as workflow params', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'wf-1' });
    const testEnv = { ...env, REBUILD_WORKFLOW: { create } };
    const req = makeRequest('/admin/full-rebuild?only=jobs', { token: ADMIN_SECRET });
    await worker.fetch(req, testEnv, {});
    expect(create.mock.calls[0][0].params).toMatchObject({ only: 'jobs' });
  });

  it('passes only=candidates / only=pipelines through', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'wf-2' });
    const testEnv = { ...env, REBUILD_WORKFLOW: { create } };
    const req1 = makeRequest('/admin/full-rebuild?only=candidates', { token: ADMIN_SECRET });
    await worker.fetch(req1, testEnv, {});
    expect(create.mock.calls[0][0].params).toMatchObject({ only: 'candidates' });

    const req2 = makeRequest('/admin/full-rebuild?only=pipelines', { token: ADMIN_SECRET });
    await worker.fetch(req2, testEnv, {});
    expect(create.mock.calls[1][0].params).toMatchObject({ only: 'pipelines' });
  });

  it('only=null when no query param', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'wf-3' });
    const testEnv = { ...env, REBUILD_WORKFLOW: { create } };
    const req = makeRequest('/admin/full-rebuild', { token: ADMIN_SECRET });
    await worker.fetch(req, testEnv, {});
    expect(create.mock.calls[0][0].params.only).toBeNull();
  });
});
