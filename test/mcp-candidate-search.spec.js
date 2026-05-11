import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

/**
 * Build a `globalThis.fetch` mock that returns the given candidate array as
 * RF `/candidate/search`'s `data` field. Use `mockRf([...])` for a happy-path
 * tier-2 call; pass `{ rejectWith: '...'}` to simulate RF unavailability.
 */
function mockRf(candidates, opts = {}) {
  if (opts.rejectWith) {
    return vi.fn().mockRejectedValue(new Error(opts.rejectWith));
  }
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: candidates, total_items: candidates.length }),
    text: async () => '',
  });
}

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
  // Also seed candidates_v2 so the snapshot (which now reads candidates_v2) can find this candidate.
  const addedMs = opts.last_activity_at ? Date.parse(opts.last_activity_at) : Date.now();
  const linkedin = opts.body?.linkedin_profile ?? null;
  await env.RF_MCP_CACHE.prepare(
    `INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, name, linkedin, addedMs, Date.now())
    .run();
};

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  resetSnapshot();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
  // ─── Pure-fuzzy short-circuit (no RF call) ──────────────────────
  it('pure-fuzzy: matches by query alone', async () => {
    await insert(1, 'Jerry Smith');
    await insert(2, 'Bob Smith');
    await insert(3, 'Alice Jones');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', query: 'jerry' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches[0].id).toBe(1);
    // Pure-fuzzy never calls RF.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when neither query nor filter provided', async () => {
    const r = await call({ consultantFirstName: 'Joel' });
    expect(r.status).toBe(400);
  });

  // ─── Mutable filters route through RF /candidate/search ─────────
  it('email exact lookup routes through RF (mutable filter)', async () => {
    await insert(1, 'Jerry', { email: 'jerry@x.com' });
    globalThis.fetch = mockRf([
      { id: 1, name: 'Jerry', primary_email: 'jerry@x.com' },
    ]);
    const r = await call({ consultantFirstName: 'Joel', email: 'jerry@x.com' });
    const b = await r.json();
    expect(b.matches[0].id).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sentBody.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'email', conjunction: 'in', values: ['jerry@x.com'] }),
    ]));
  });

  it('combines filter + query (tier-1 + RF predicate, single round-trip)', async () => {
    await insert(1, 'Jerry Smith', { owner: 100 });
    await insert(2, 'Jerry Jones', { owner: 200 });
    globalThis.fetch = mockRf([
      // RF returns only owner-100 matches.
      { id: 1, name: 'Jerry Smith' },
    ]);
    const r = await call({ consultantFirstName: 'Joel', query: 'jerry', owner_id: 100 });
    const b = await r.json();
    expect(b.matches.length).toBe(1);
    expect(b.matches[0].id).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sentBody.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'candidate_id', conjunction: 'in' }),
      expect.objectContaining({ key: 'lead_owner', values: [100] }),
    ]));
  });

  it('owner accepts our-team first name (Joel → 900001) and routes through RF', async () => {
    await insert(1, 'Alice', { owner: 900001 });
    globalThis.fetch = mockRf([{ id: 1, name: 'Alice' }]);
    const r = await call({ consultantFirstName: 'Joel', owner: 'Joel' });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sentBody.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'lead_owner', values: [900001] }),
    ]));
  });

  it('owner accepts numeric id as string', async () => {
    await insert(1, 'Alice', { owner: 900001 });
    globalThis.fetch = mockRf([{ id: 1, name: 'Alice' }]);
    const r = await call({ consultantFirstName: 'Joel', owner: '900001' });
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
  });

  it('owner unknown fuzzy name → 400 (no RF call)', async () => {
    await insert(1, 'Alice', { owner: 900001 });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', owner: 'NonexistentPerson' });
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('job filter routes through RF as job-by-id', async () => {
    await env.RF_MCP_CACHE
      .prepare(
        `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(100, JSON.stringify({}), 'Enterprise AE', 'Nominal', 1, new Date().toISOString())
      .run();
    await insert(1, 'Alice');
    globalThis.fetch = mockRf([{ id: 1, name: 'Alice' }]);
    const r = await call({ consultantFirstName: 'Joel', job: 'Enterprise AE' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sentBody.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'job', values: [100] }),
    ]));
  });

  it('lowercase stage with job filter resolves to canonical and passes to RF', async () => {
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
    globalThis.fetch = mockRf([{ id: 1, name: 'Alice' }]);
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'sourced' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sentBody.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'job', values: [100] }),
      // Canonical-cased stage name passed verbatim.
      expect.objectContaining({ key: 'stage', values: ['Sourced'] }),
    ]));
  });

  it('ambiguous stage with job filter → 200 needs_disambiguation kind=stage (no RF call)', async () => {
    await env.RF_MCP_CACHE
      .prepare(
        `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(100, JSON.stringify({}), 'Enterprise AE', 'Nominal', 1, new Date().toISOString())
      .run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, '1st Interview', 0)`,
    ).run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (2, 100, '2nd Interview', 0)`,
    ).run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (3, 100, 'Final Interview', 0)`,
    ).run();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    expect(b.options.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unknown stage with job filter falls through to RF (returns RF empty result)', async () => {
    await env.RF_MCP_CACHE
      .prepare(
        `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(100, JSON.stringify({}), 'Enterprise AE', 'Nominal', 1, new Date().toISOString())
      .run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidate_jobs (candidate_id, job_id, stage_name, disqualified) VALUES (1, 100, 'Sourced', 0)`,
    ).run();
    globalThis.fetch = mockRf([]);  // RF returns empty for unknown stage.
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'totally-not-a-real-stage' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.count).toBe(0);
  });

  it('disqualified=true filters FOR DQ candidates via stage=Disqualified RF filter', async () => {
    // Per spec rev 5 "Filter-to-source map": `disqualified` is a filter that
    // SELECTS ONLY DQ candidates (not the legacy `include_disqualified` knob
    // which gated DQ inclusion on the cache-side job join).
    await insert(1, 'Alice');
    globalThis.fetch = mockRf([{ id: 1, name: 'Alice' }]);
    const r = await call({ consultantFirstName: 'Joel', query: 'alice', disqualified: true });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([1]);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    const stageFilter = sentBody.filters.find((f) => f.key === 'stage');
    expect(stageFilter.values).toEqual(['Disqualified']);
  });

  it('honours fields[] alias projection on RF results', async () => {
    await insert(1, 'Jerry');
    globalThis.fetch = mockRf([
      {
        id: 1,
        name: 'Jerry',
        primary_email: 'jerry@x.com',
        current_organization: 'Acme',
        linkedin_profile: 'jerry-x',
      },
    ]);
    const r = await call({
      consultantFirstName: 'Joel',
      email: 'jerry@x.com',
      fields: ['email', 'company', 'linkedin'],
    });
    const b = await r.json();
    expect(b.matches[0].primary_email).toBe('jerry@x.com');
    expect(b.matches[0].current_organization).toBe('Acme');
    expect(b.matches[0].linkedin_profile).toBe('https://www.linkedin.com/in/jerry-x');
  });

  it('default fields are id, name, current_title, linkedin_profile only', async () => {
    await insert(1, 'A', { body: { current_title: 'CTO', linkedin_profile: 'a-slug', primary_email: 'a@x.com' } });
    const r = await call({ consultantFirstName: 'Joel', query: 'A' });
    const body = await r.json();
    const m = body.matches[0];
    expect(Object.keys(m).filter((k) => k !== 'score').sort()).toEqual(
      ['current_title', 'id', 'linkedin_profile', 'name'],
    );
  });

  it('LinkedIn returned as URL', async () => {
    await insert(1, 'A', { body: { linkedin_profile: 'a-slug' } });
    const r = await call({ consultantFirstName: 'Joel', query: 'A' });
    const body = await r.json();
    expect(body.matches[0].linkedin_profile).toBe('https://www.linkedin.com/in/a-slug');
  });

  it('fields extends defaults', async () => {
    await insert(1, 'A', { body: { current_organization: 'Acme', linkedin_profile: 'a' } });
    const r = await call({ consultantFirstName: 'Joel', query: 'A', fields: ['company'] });
    const body = await r.json();
    const m = body.matches[0];
    expect(m.id).toBe(1);
    expect(m.linkedin_profile).toBe('https://www.linkedin.com/in/a');
    expect(m.current_organization).toBe('Acme');
  });

  it('job_id bypasses fuzzy resolver and routes through RF', async () => {
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    ).bind(50, JSON.stringify({ id: 50, name: 'Sales' }), 'Sales', 'Acme', new Date().toISOString()).run();
    await insert(1, 'A');
    globalThis.fetch = mockRf([{ id: 1, name: 'A' }]);
    const r = await call({ consultantFirstName: 'Joel', job_id: 50 });
    const body = await r.json();
    expect(body.matches.map((m) => m.id)).toEqual([1]);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sentBody.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'job', values: [50] }),
    ]));
  });

  it('owner_id bypasses fuzzy resolver and routes through RF', async () => {
    await insert(1, 'A', { owner: 9999 });
    globalThis.fetch = mockRf([{ id: 1, name: 'A' }]);
    const r = await call({ consultantFirstName: 'Joel', owner_id: 9999 });
    const body = await r.json();
    expect(body.matches.map((m) => m.id)).toContain(1);
    const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sentBody.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'lead_owner', values: [9999] }),
    ]));
  });

  it('_meta omitted on clean calls', async () => {
    await insert(1, 'A');
    const r = await call({ consultantFirstName: 'Joel', query: 'A' });
    const body = await r.json();
    expect(body._meta).toBeUndefined();
  });

  // ─── Custom-field filters (technology / segment / role) ─────────
  // Per spec rev 5, these are MUTABLE and route through RF as
  // `custom_field.<id>`; until the id-mapping table lands, they're logged-
  // and-ignored. Verify the resolver still handles ambiguity (so Claude's
  // disambiguation contract holds) and the request returns gracefully.
  it('lowercase technology resolves to canonical case (resolver still runs)', async () => {
    // Resolver needs the option universe — seed two candidates with technology values.
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Technology', value: ['Kubernetes', 'Go'] }] },
    });
    await insert(2, 'Bob', {
      body: { custom_fields: [{ name: 'Technology', value: ['Postgres'] }] },
    });
    // No fuzzy query → tier-1 doesn't fire. With only the (currently-dropped)
    // technology filter, no mutable filters reach RF, so nothing to predicate
    // on — handler 400s for "no filter provided".
    // The resolver runs successfully (no ambiguity envelope, no 500).
    const r = await call({ consultantFirstName: 'Joel', technology: ['kubernetes'] });
    expect(r.status).toBe(400);
  });

  it('lowercase segment resolves to canonical case (resolver still runs)', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Segment', value: 'Enterprise' }] },
    });
    const r = await call({ consultantFirstName: 'Joel', segment: 'enterprise' });
    // Same as technology — no mutable filter routed since custom_field.<id>
    // mapping isn't wired; resolver passed (no ambiguity envelope).
    expect(r.status).toBe(400);
  });

  it('lowercase role resolves to canonical case (resolver still runs)', async () => {
    await insert(1, 'Alice', {
      body: { custom_fields: [{ name: 'Role', value: 'AE' }] },
    });
    const r = await call({ consultantFirstName: 'Joel', role: 'ae' });
    expect(r.status).toBe(400);
  });

  // ─── Immutable-only filter path (no RF call) ────────────────────
  it('immutable-only filter (added_after) narrows in-cache without RF', async () => {
    await insert(1, 'Old', { last_activity_at: '2025-01-01T00:00:00Z' });
    await insert(2, 'Recent', { last_activity_at: '2026-05-10T00:00:00Z' });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', added_after: '2026-04-01T00:00:00Z' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.matches.map((m) => m.id)).toEqual([2]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── New tier-1+RF single round-trip tests (Task 13 spec) ──────────
describe('rf_candidate_search — tier-1+RF-search single round-trip', () => {
  beforeEach(async () => {
    await applyMigration(env);
    await applyUsersMigration(env);
    _resetCacheForTests();
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
    resetSnapshot();
    await env.RF_MCP_CACHE
      .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
      .bind(new Date().toISOString())
      .run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function seedThin(rows) {
    for (const r of rows) {
      await env.RF_MCP_CACHE.prepare(
        `INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)`
      ).bind(r.id, r.name, r.linkedin_profile ?? null, r.added_time_ms ?? Date.now(), Date.now()).run();
    }
  }

  it('routes mutable filter (company) through ONE RF /candidate/search with id-list + predicate', async () => {
    await seedThin([
      { id: 1, name: 'Jane Doe',   linkedin_profile: 'jane-doe',   added_time_ms: 1 },
      { id: 2, name: 'Jane Smith', linkedin_profile: 'jane-smith', added_time_ms: 2 },
      { id: 3, name: 'Jane Park',  linkedin_profile: 'jane-park',  added_time_ms: 3 },
    ]);
    const rfFetch = mockRf([{ id: 2, name: 'Jane Smith', current_organization: 'Acme' }]);
    globalThis.fetch = rfFetch;

    const r = await call({ consultantFirstName: 'Joel', query: 'jane', company: 'Acme' });
    const res = await r.json();
    expect(res.matches.map((m) => m.id)).toEqual([2]);
    expect(rfFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(rfFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'candidate_id', conjunction: 'in' }),
      expect.objectContaining({ key: 'current_company' }),
    ]));
    const idFilter = body.filters.find((f) => f.key === 'candidate_id');
    expect(idFilter.values).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it('routes mutable filter via the long-tail `filters` envelope', async () => {
    await seedThin([
      { id: 1, name: 'Jane', added_time_ms: 1 },
    ]);
    const rfFetch = mockRf([{ id: 1, name: 'Jane' }]);
    globalThis.fetch = rfFetch;
    const r = await call({ consultantFirstName: 'Joel', query: 'jane', filters: { company: 'Acme' } });
    const res = await r.json();
    expect(res.matches.map((m) => m.id)).toEqual([1]);
    expect(rfFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(rfFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'current_company' }),
    ]));
  });

  it('skips RF entirely when no mutable filters', async () => {
    await seedThin([
      { id: 1, name: 'Jane', added_time_ms: 1 },
    ]);
    const rfFetch = vi.fn();
    globalThis.fetch = rfFetch;
    const r = await call({ consultantFirstName: 'Joel', query: 'jane' });
    const res = await r.json();
    expect(rfFetch).not.toHaveBeenCalled();
    expect(res.matches.map((m) => m.id)).toEqual([1]);
  });

  it('on RF failure, degrades to tier-1 with filter_unverified warning', async () => {
    await seedThin([
      { id: 1, name: 'Jane', added_time_ms: 1 },
    ]);
    globalThis.fetch = mockRf([], { rejectWith: 'boom' });
    const r = await call({ consultantFirstName: 'Joel', query: 'jane', company: 'Acme' });
    const res = await r.json();
    expect(res.warning).toMatch(/filter_unverified/);
    expect(res.matches.map((m) => m.id)).toEqual([1]);
  });

  it('tier-1 empty + mutable filter present → returns empty without RF call', async () => {
    // No candidates seeded → tier-1 returns nothing.
    const rfFetch = vi.fn();
    globalThis.fetch = rfFetch;
    const r = await call({ consultantFirstName: 'Joel', query: 'nobody-matches', company: 'Acme' });
    const res = await r.json();
    expect(rfFetch).not.toHaveBeenCalled();
    expect(res.matches).toEqual([]);
  });

  it('disqualified=true expands to stage=Disqualified RF filter', async () => {
    await seedThin([
      { id: 1, name: 'Jane', added_time_ms: 1 },
    ]);
    const rfFetch = mockRf([]);
    globalThis.fetch = rfFetch;
    await call({ consultantFirstName: 'Joel', query: 'jane', disqualified: true });
    const body = JSON.parse(rfFetch.mock.calls[0][1].body);
    const stageFilter = body.filters.find((f) => f.key === 'stage');
    expect(stageFilter.values).toEqual(['Disqualified']);
  });

  it('predicate-only RF search when no fuzzy query (filter alone)', async () => {
    await seedThin([
      { id: 1, name: 'Alice', added_time_ms: 1 },
    ]);
    const rfFetch = mockRf([{ id: 99, name: 'Found via RF', primary_email: 'x@y.com' }]);
    globalThis.fetch = rfFetch;
    const r = await call({ consultantFirstName: 'Joel', email: 'x@y.com' });
    const res = await r.json();
    expect(res.matches.map((m) => m.id)).toEqual([99]);
    expect(rfFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(rfFetch.mock.calls[0][1].body);
    // No candidate_id filter on the predicate-only path.
    expect(body.filters.find((f) => f.key === 'candidate_id')).toBeUndefined();
    expect(body.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'email', values: ['x@y.com'] }),
    ]));
  });

  // ─── Fix 1: added_after + mutable filter routes both to RF ────────
  it('routes added_after through RF when present alongside a mutable filter (no query)', async () => {
    const rfFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    });
    globalThis.fetch = rfFetch;
    await call({ consultantFirstName: 'Joel', email: 'x@y.com', added_after: '2026-04-08' });
    expect(rfFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(rfFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'email' }),
      expect.objectContaining({ key: 'added_on', filter_type: 'after', date: '2026-04-08' }),
    ]));
  });

  it('routes added_before through RF alongside a mutable filter', async () => {
    const rfFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    });
    globalThis.fetch = rfFetch;
    await call({ consultantFirstName: 'Joel', email: 'x@y.com', added_before: '2026-04-30' });
    expect(rfFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(rfFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'added_on', filter_type: 'before', date: '2026-04-30' }),
    ]));
  });

  // ─── Fix 3: linkedin_profile dual-handled ─────────────────────────
  it('linkedin_profile exact-slug filters tier-1 snapshot on pure-fuzzy path', async () => {
    await seedThin([
      { id: 1, name: 'Jane Doe',   linkedin_profile: 'jane-doe',   added_time_ms: 1 },
      { id: 2, name: 'Jane Smith', linkedin_profile: 'jane-smith', added_time_ms: 2 },
    ]);
    const rfFetch = vi.fn();
    globalThis.fetch = rfFetch;
    // Pure-fuzzy path (no mutable filter): snapshot exact-slug match narrows.
    const r = await call({ consultantFirstName: 'Joel', query: 'jane', linkedin_profile: 'jane-doe' });
    const res = await r.json();
    expect(rfFetch).not.toHaveBeenCalled();
    expect(res.matches.map((m) => m.id)).toEqual([1]);
  });

  it('linkedin_profile substring filter reaches RF on tier-2 path (mutable filter present)', async () => {
    await seedThin([
      { id: 1, name: 'Jane Doe',   linkedin_profile: 'jane-doe',   added_time_ms: 1 },
    ]);
    const rfFetch = mockRf([{ id: 1, name: 'Jane Doe' }]);
    globalThis.fetch = rfFetch;
    // Mutable filter (email) triggers tier-2; linkedin_profile also goes to RF.
    const r = await call({ consultantFirstName: 'Joel', email: 'jane@acme.com', linkedin_profile: 'jane-doe' });
    const res = await r.json();
    expect(rfFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(rfFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'linkedin_profile', values: ['jane-doe'] }),
    ]));
  });

  // ─── Fix 5: custom-field warning surfaces ─────────────────────────
  it('drops technology filter with warning surfaced to caller', async () => {
    await seedThin([{ id: 1, name: 'Jane', added_time_ms: 1 }]);
    const rfFetch = vi.fn();
    globalThis.fetch = rfFetch;
    const r = await call({ consultantFirstName: 'Joel', query: 'jane', technology: ['Kubernetes'] });
    const res = await r.json();
    // warning should be present since technology was dropped
    expect(res.warning ?? res._meta?.warning).toMatch(/custom_field/i);
    expect(res._meta?.unverifiedFilters).toContain('technology');
  });
});
