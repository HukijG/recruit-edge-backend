import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-get', {
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
    id: 42, first_name: 'Jerry', last_name: 'Smith', name: 'Jerry Smith',
    primary_email: 'jerry@x.com', linkedin_profile: 'jerry-smith',
    jobs: [{ job_name: 'Eng', client_company_name: 'Acme', stage_name: 'Sourced' }],
  }), 'Jerry Smith', new Date().toISOString()).run();
});

describe('/mcp/candidate-get', () => {
  it('returns full candidate by id with default projection', async () => {
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidate.first_name).toBe('Jerry');
    expect(body.candidate.jobs[0].stage_name).toBe('Sourced');
  });

  it('returns 404 for missing id', async () => {
    const r = await call({ consultantFirstName: 'Joel', id: 999 });
    expect(r.status).toBe(404);
  });

  it('honours fields[] projection with aliases', async () => {
    const r = await call({ consultantFirstName: 'Joel', id: 42, fields: ['name', 'linkedin', 'company'] });
    const body = await r.json();
    expect(body.candidate.name).toBe('Jerry Smith');
    expect(body.candidate.linkedin_profile).toBe('jerry-smith');
  });

  it('returns 400 if neither id nor query provided', async () => {
    const r = await call({ consultantFirstName: 'Joel' });
    expect(r.status).toBe(400);
  });
});
