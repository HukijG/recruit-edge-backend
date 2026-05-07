import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

const insert = async (id, name, opts = {}) => {
  await env.RF_MCP_CACHE.prepare(
    `INSERT INTO candidates (id, body, name, primary_email, lead_owner_id, last_updated, last_activity_at, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      JSON.stringify({
        id,
        name,
        primary_email: opts.email ?? null,
        last_activity_at: opts.last_activity_at ?? null,
        ...opts.body,
      }),
      name,
      opts.email ?? null,
      opts.owner ?? null,
      opts.last_updated ?? new Date().toISOString(),
      opts.last_activity_at ?? null,
      new Date().toISOString(),
    )
    .run();
};

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  resetSnapshot();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
});

const call = (b) =>
  worker.fetch(
    new Request('http://x/mcp/candidate-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify(b),
    }),
    env,
    createExecutionContext(),
  );

describe('/mcp/candidate-search', () => {
  it('pure-fuzzy: matches by query alone', async () => {
    await insert(1, 'Jerry Smith');
    await insert(2, 'Bob Smith');
    await insert(3, 'Alice Jones');
    const r = await call({ consultantFirstName: 'Joel', query: 'jerry' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches[0].id).toBe(1);
  });

  it('filter only: returns rows by last_updated DESC', async () => {
    await insert(1, 'A', { owner: 100, last_updated: '2026-01-01T00:00:00Z' });
    await insert(2, 'B', { owner: 100, last_updated: '2026-05-01T00:00:00Z' });
    const r = await call({ consultantFirstName: 'Joel', owner: '100' });
    const b = await r.json();
    expect(b.count).toBeGreaterThan(0);
    expect(b.matches[0].id).toBe(2);
  });

  it('email exact lookup', async () => {
    await insert(1, 'Jerry', { email: 'jerry@x.com' });
    const r = await call({ consultantFirstName: 'Joel', email: 'jerry@x.com' });
    const b = await r.json();
    expect(b.matches[0].id).toBe(1);
  });

  it('email is case-insensitive', async () => {
    await insert(1, 'Jerry', { email: 'jerry@x.com' });
    const r = await call({ consultantFirstName: 'Joel', email: 'JERRY@X.COM' });
    const b = await r.json();
    expect(b.matches[0].id).toBe(1);
  });

  it('combines filter + query (filter narrows, then fuzzy ranks)', async () => {
    await insert(1, 'Jerry Smith', { owner: 100 });
    await insert(2, 'Jerry Jones', { owner: 200 });
    const r = await call({ consultantFirstName: 'Joel', query: 'jerry', owner: '100' });
    const b = await r.json();
    expect(b.matches.length).toBe(1);
    expect(b.matches[0].id).toBe(1);
  });

  it('returns 400 when neither query nor filter provided', async () => {
    const r = await call({ consultantFirstName: 'Joel' });
    expect(r.status).toBe(400);
  });

  it('technology filter matches when ANY value present', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Technology', value: ['Kubernetes', 'Go'] }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Technology', value: ['Postgres'] }] },
    });
    const r = await call({ consultantFirstName: 'Joel', technology: ['Kubernetes'] });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('technology filter ORs across array', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Technology', value: ['Kubernetes', 'Go'] }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Technology', value: ['Postgres'] }] },
    });
    await insert(3, 'Carol', {
      body: { custom_fields: [{ name: 'Technology', value: ['Java'] }] },
    });
    const r = await call({ consultantFirstName: 'Joel', technology: ['Postgres', 'Go'] });
    const b = await r.json();
    expect(b.matches.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  it('segment filter exact-matches', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Segment', value: 'Enterprise' }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Segment', value: 'SMB' }] },
    });
    const hit = await (await call({ consultantFirstName: 'Joel', segment: 'Enterprise' })).json();
    expect(hit.matches.map((m) => m.id)).toEqual([1]);
    const miss = await (await call({ consultantFirstName: 'Joel', segment: 'Mid-Market' })).json();
    expect(miss.count).toBe(0);
  });

  it('role filter exact-matches', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Role', value: 'AE' }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Role', value: 'CSM' }] },
    });
    const hit = await (await call({ consultantFirstName: 'Joel', role: 'AE' })).json();
    expect(hit.matches.map((m) => m.id)).toEqual([1]);
  });

  it('include_disqualified=false (default) excludes DQ candidates from job filter', async () => {
    await insert(1, 'Alice');
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, 'Sourced', 1)`,
    ).run();
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    const b = await r.json();
    expect(b.count).toBe(0);
  });

  it('include_disqualified=true includes DQ candidates', async () => {
    await insert(1, 'Alice');
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, 'Sourced', 1)`,
    ).run();
    const r = await call({ consultantFirstName: 'Joel', job: 100, include_disqualified: true });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('owner accepts our-team first name (Joel → 900001)', async () => {
    await insert(1, 'Alice', { owner: 900001 });
    await insert(2, 'Bob', { owner: 200 });
    const r = await call({ consultantFirstName: 'Joel', owner: 'Joel' });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('owner accepts numeric id as string', async () => {
    await insert(1, 'Alice', { owner: 900001 });
    await insert(2, 'Bob', { owner: 200 });
    const r = await call({ consultantFirstName: 'Joel', owner: '900001' });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('owner unknown fuzzy name → 400', async () => {
    await insert(1, 'Alice', { owner: 900001 });
    const r = await call({ consultantFirstName: 'Joel', owner: 'NonexistentPerson' });
    expect(r.status).toBe(400);
  });

  it('job accepts a fuzzy job name', async () => {
    await env.RF_MCP_CACHE
      .prepare(
        `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(100, JSON.stringify({}), 'Enterprise AE', 'Nominal', 1, new Date().toISOString())
      .run();
    await insert(1, 'Alice');
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, 'Sourced', 0)`,
    ).run();
    const r = await call({ consultantFirstName: 'Joel', job: 'Enterprise AE' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('lowercase stage with job filter resolves to canonical', async () => {
    await env.RF_MCP_CACHE
      .prepare(
        `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(100, JSON.stringify({}), 'Enterprise AE', 'Nominal', 1, new Date().toISOString())
      .run();
    await insert(1, 'Alice');
    await insert(2, 'Bob');
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, 'Sourced', 0)`,
    ).run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (2, 100, 'CV Sent', 0)`,
    ).run();
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'sourced' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('ambiguous stage with job filter → 200 needs_disambiguation kind=stage', async () => {
    await env.RF_MCP_CACHE
      .prepare(
        `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(100, JSON.stringify({}), 'Enterprise AE', 'Nominal', 1, new Date().toISOString())
      .run();
    await insert(1, 'Alice');
    await insert(2, 'Bob');
    await insert(3, 'Carol');
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, '1st Interview', 0)`,
    ).run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (2, 100, '2nd Interview', 0)`,
    ).run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (3, 100, 'Final Interview', 0)`,
    ).run();
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    expect(b.options.length).toBeGreaterThanOrEqual(2);
  });

  it('unknown stage with job filter falls through (empty matches, not 400)', async () => {
    await env.RF_MCP_CACHE
      .prepare(
        `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(100, JSON.stringify({}), 'Enterprise AE', 'Nominal', 1, new Date().toISOString())
      .run();
    await insert(1, 'Alice');
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, 'Sourced', 0)`,
    ).run();
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'totally-not-a-real-stage' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.count).toBe(0);
  });

  it('lowercase technology resolves to canonical case', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Technology', value: ['Kubernetes', 'Go'] }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Technology', value: ['Postgres'] }] },
    });
    const r = await call({ consultantFirstName: 'Joel', technology: ['kubernetes'] });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('lowercase segment resolves to canonical case', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Segment', value: 'Enterprise' }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Segment', value: 'SMB' }] },
    });
    const r = await call({ consultantFirstName: 'Joel', segment: 'enterprise' });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('lowercase role resolves to canonical case', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Role', value: 'AE' }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Role', value: 'CSM' }] },
    });
    const r = await call({ consultantFirstName: 'Joel', role: 'ae' });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('honours fields[] alias projection', async () => {
    await insert(1, 'Jerry', {
      email: 'jerry@x.com',
      body: { current_organization: 'Acme', linkedin_profile: 'jerry-x' },
    });
    const r = await call({
      consultantFirstName: 'Joel',
      email: 'jerry@x.com',
      fields: ['email', 'company', 'linkedin'],
    });
    const b = await r.json();
    expect(b.matches[0].primary_email).toBe('jerry@x.com');
    expect(b.matches[0].current_organization).toBe('Acme');
    expect(b.matches[0].linkedin_profile).toBe('jerry-x');
  });
});
