import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

beforeEach(async () => { await applyMigration(env); });

async function call(path, body, headers = {}) {
  const r = new Request('http://x' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return worker.fetch(r, env, createExecutionContext());
}

describe('mcp router', () => {
  it('returns 401 without X-MCP-Token', async () => {
    const r = await call('/mcp/cache-status', { consultantFirstName: 'Joel' });
    expect(r.status).toBe(401);
  });
  it('returns 401 with wrong token', async () => {
    const r = await call('/mcp/cache-status', { consultantFirstName: 'Joel' }, { 'X-MCP-Token': 'nope' });
    expect(r.status).toBe(401);
  });
  it('returns 403 for unknown consultant (right token)', async () => {
    const r = await call('/mcp/cache-status', { consultantFirstName: 'Nobody' }, { 'X-MCP-Token': 'test-mcp-extension-secret' });
    expect(r.status).toBe(403);
  });
  it('returns 404 for unknown /mcp/* path (right token + known consultant)', async () => {
    const r = await call('/mcp/does-not-exist', { consultantFirstName: 'Joel' }, { 'X-MCP-Token': 'test-mcp-extension-secret' });
    expect(r.status).toBe(404);
  });
});
