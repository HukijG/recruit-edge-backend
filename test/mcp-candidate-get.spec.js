import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
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
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  resetSnapshot();
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (?, ?, ?, ?)'
  ).bind(42, JSON.stringify({
    id: 42, first_name: 'Jerry', last_name: 'Smith', name: 'Jerry Smith',
    primary_email: 'jerry@x.com', linkedin_profile: 'jerry-smith',
    jobs: [{ job_name: 'Eng', client_company_name: 'Acme', stage_name: 'Sourced' }],
  }), 'Jerry Smith', new Date().toISOString()).run();
  await env.RF_MCP_CACHE.prepare(
    'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
  ).bind(42, 'Jerry Smith', null, Date.now(), Date.now()).run();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
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
    expect(body.candidate.linkedin_profile).toBe('https://www.linkedin.com/in/jerry-smith');
  });

  it('returns 400 if neither id nor query provided', async () => {
    const r = await call({ consultantFirstName: 'Joel' });
    expect(r.status).toBe(400);
  });

  it('fuzzy query: resolves either uniquely or via needs_disambiguation', async () => {
    // Add a second "Jerry" so the query is genuinely ambiguous against
    // the seeded "Jerry Smith". Either a single confident match (if scoring
    // separates them by ≥ UNIQUE_GAP) or `needs_disambiguation` is correct.
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, cached_at) VALUES (?, ?, ?, ?)'
    ).bind(43, JSON.stringify({
      id: 43, first_name: 'Jerry', last_name: 'Jones', name: 'Jerry Jones',
    }), 'Jerry Jones', new Date().toISOString()).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(43, 'Jerry Jones', null, Date.now(), Date.now()).run();
    // Bump tail cursor so the snapshot rebuilds against the new row set.
    await env.RF_MCP_CACHE.exec("DELETE FROM sync_state WHERE key='last_tail_sync_at'");
    await env.RF_MCP_CACHE
      .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
      .bind(new Date(Date.now() + 1000).toISOString())
      .run();
    resetSnapshot();
    const r = await call({ consultantFirstName: 'Joel', query: 'jerry' });
    expect(r.status).toBe(200);
    const b = await r.json();
    if (b.needs_disambiguation) {
      expect(b.options.length).toBeGreaterThanOrEqual(2);
      const ids = b.options.map((o) => o.id).sort();
      expect(ids).toEqual([42, 43]);
    } else {
      expect([42, 43]).toContain(b.candidate.id);
    }
  });

  it('fuzzy query with no matches returns 404', async () => {
    const r = await call({ consultantFirstName: 'Joel', query: 'zzzzzzzzzz' });
    expect(r.status).toBe(404);
  });

  it('returns LinkedIn as a full URL', async () => {
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    const body = await r.json();
    expect(body.candidate.linkedin_profile).toBe('https://www.linkedin.com/in/jerry-smith');
  });

  it('fields extends defaults — does not replace them', async () => {
    const r = await call({ consultantFirstName: 'Joel', id: 42, fields: ['title'] });
    const body = await r.json();
    // Defaults still present:
    expect(body.candidate.id).toBe(42);
    expect(body.candidate.primary_email).toBe('jerry@x.com');
    expect(body.candidate.linkedin_profile).toBe('https://www.linkedin.com/in/jerry-smith');
  });

  it('_meta absent on a clean call', async () => {
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    const body = await r.json();
    expect(body._meta).toBeUndefined();
  });

  it('default rich set includes current_organization + linkedin_profile', async () => {
    // Seeded candidate has linkedin_profile and a job's client_company_name but
    // not a top-level current_organization. Confirm linkedin_profile (URL) is
    // returned by default, and the new field set doesn't crash if
    // current_organization is missing.
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    const body = await r.json();
    expect(body.candidate.linkedin_profile).toBe('https://www.linkedin.com/in/jerry-smith');
  });
});
