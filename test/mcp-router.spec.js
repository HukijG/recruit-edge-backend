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
});

async function call(path, body, headers = {}) {
  const r = new Request('http://x' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return worker.fetch(r, env, createExecutionContext());
}

describe('mcp router', () => {
  it('resolves consultant from consultantEmail (no token required on binding path)', async () => {
    const r = await call('/mcp/cache-status', { consultantEmail: 'joel@test.local' });
    expect(r.status).toBe(200);
  });

  it('returns 403 for unknown consultantEmail', async () => {
    const r = await call('/mcp/cache-status', { consultantEmail: 'nobody@test.local' });
    expect(r.status).toBe(403);
  });

  it('falls back to consultantFirstName during transition', async () => {
    const r = await call('/mcp/cache-status', { consultantFirstName: 'Joel' });
    expect(r.status).toBe(200);
  });

  it('returns 403 when neither consultantEmail nor consultantFirstName resolves', async () => {
    const r = await call('/mcp/cache-status', {});
    expect(r.status).toBe(403);
  });

  it('returns 404 for unknown /mcp/* path (with valid consultant)', async () => {
    const r = await call('/mcp/does-not-exist', { consultantEmail: 'joel@test.local' });
    expect(r.status).toBe(404);
  });

  it('email takes priority when both consultantEmail and consultantFirstName are present', async () => {
    // If the if/else-if ever flips to two `if` blocks, this catches it: an
    // unknown email + valid firstName should 403, NOT fall through to the
    // legacy resolver. Once Access is live, the JWT-derived email is the
    // verified identity — letting a stale name override it would be a hole.
    const r = await call('/mcp/cache-status', {
      consultantEmail: 'nobody@test.local',
      consultantFirstName: 'Joel',
    });
    expect(r.status).toBe(403);
  });
});
