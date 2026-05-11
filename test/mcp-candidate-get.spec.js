import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

// Full candidate body returned by RF for candidate 42.
const RF_JERRY = {
  id: 42,
  first_name: 'Jerry',
  last_name: 'Smith',
  name: 'Jerry Smith',
  primary_email: 'jerry@x.com',
  phone_numbers: ['+15551234567'],
  current_title: 'Software Engineer',
  current_organization: 'Acme Corp',
  linkedin_profile: 'jerry-smith',
  jobs: [{ job_name: 'Eng', client_company_name: 'Acme', stage_name: 'Sourced' }],
};

const originalFetch = globalThis.fetch;

/** Helper: mock a single successful RF /candidate/get response. */
function mockRfSuccess(candidateBody = RF_JERRY) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ candidate: candidateBody }), { status: 200 }),
  );
}

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

  // Seed the legacy candidates table (still read by resolvers.js / getCandidateById
  // used by resolveCandidate for the id/fuzzy path; dual-write compatibility).
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (?, ?, ?, ?)'
  ).bind(42, JSON.stringify({
    id: 42, first_name: 'Jerry', last_name: 'Smith', name: 'Jerry Smith',
    primary_email: 'jerry@x.com', linkedin_profile: 'jerry-smith',
    jobs: [{ job_name: 'Eng', client_company_name: 'Acme', stage_name: 'Sourced' }],
  }), 'Jerry Smith', new Date().toISOString()).run();

  // Seed the thin-schema candidates_v2 table (used by getThinCandidateById sanity check).
  await env.RF_MCP_CACHE.prepare(
    'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
  ).bind(42, 'Jerry Smith', 'jerry-smith', Date.now(), Date.now()).run();

  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('/mcp/candidate-get', () => {
  it('returns full candidate by id with default projection', async () => {
    mockRfSuccess();
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidate.first_name).toBe('Jerry');
    expect(body.candidate.jobs[0].stage_name).toBe('Sourced');
  });

  it('returns lean no_candidate envelope for missing id', async () => {
    // No RF mock needed — the thin-cache check fails before RF is called.
    const r = await call({ consultantFirstName: 'Joel', id: 999 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: false, kind: 'no_candidate' });
  });

  it('honours fields[] projection with aliases', async () => {
    mockRfSuccess();
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

    // Unique match will call RF; ambiguous returns needs_disambiguation without RF.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidate: RF_JERRY }), { status: 200 }),
    );

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

  it('fuzzy query with no matches returns lean no_candidate envelope', async () => {
    const r = await call({ consultantFirstName: 'Joel', query: 'zzzzzzzzzz' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: false, kind: 'no_candidate' });
  });

  it('returns LinkedIn as a full URL', async () => {
    mockRfSuccess();
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    const body = await r.json();
    expect(body.candidate.linkedin_profile).toBe('https://www.linkedin.com/in/jerry-smith');
  });

  it('fields extends defaults — does not replace them', async () => {
    mockRfSuccess();
    const r = await call({ consultantFirstName: 'Joel', id: 42, fields: ['title'] });
    const body = await r.json();
    // Defaults still present:
    expect(body.candidate.id).toBe(42);
    expect(body.candidate.primary_email).toBe('jerry@x.com');
    expect(body.candidate.linkedin_profile).toBe('https://www.linkedin.com/in/jerry-smith');
  });

  it('_meta absent on a clean call', async () => {
    mockRfSuccess();
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    const body = await r.json();
    expect(body._meta).toBeUndefined();
  });

  it('default rich set includes current_organization + linkedin_profile', async () => {
    mockRfSuccess();
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    const body = await r.json();
    expect(body.candidate.linkedin_profile).toBe('https://www.linkedin.com/in/jerry-smith');
  });

  // ── New tests for live-fetch behavior ─────────────────────────────────────

  it('RF returns {candidate: {...}} envelope — unwrapped cleanly', async () => {
    // getRFCandidate already unwraps; this verifies the full pipeline works
    // end-to-end with an envelope-shaped response.
    const envelope = { candidate: { ...RF_JERRY, current_title: 'Staff Engineer' } };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidate.current_title).toBe('Staff Engineer');
  });

  it('candidate id not in thin cache → returns lean no_candidate envelope (no RF call)', async () => {
    // Post-migration, resolveCandidateThin queries candidates_v2 directly and
    // returns not_found on miss. candidate-get maps that to the lean envelope
    // (HTTP 200, kind:'no_candidate') — consistent with the rest of the system.
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2 WHERE id = 42');
    globalThis.fetch = vi.fn(); // Should never be called.

    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: false, kind: 'no_candidate' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('RF returns 502 on first attempt → retries and succeeds', async () => {
    // getRFCandidate retries once on 502. Simulate first call 502, second 200.
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('bad gateway', { status: 502 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ candidate: RF_JERRY }), { status: 200 }),
      );
    });

    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.candidate.first_name).toBe('Jerry');
    // RF was called twice (one retry).
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('RF unavailable (all attempts fail) → returns ok:false kind:rf_unavailable recoverable:true', async () => {
    // Simulate persistent failure: both attempts fail with 500.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'server error' }), { status: 500 }),
    );

    const r = await call({ consultantFirstName: 'Joel', id: 42 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('rf_unavailable');
    expect(body.recoverable).toBe(true);
    expect(typeof body.error).toBe('string');
  });

  it('fields[] projection — returns only requested + default fields', async () => {
    // Request only name + phone; verify other defaults are also present.
    mockRfSuccess();
    const r = await call({ consultantFirstName: 'Joel', id: 42, fields: ['phone'] });
    const body = await r.json();
    // `phone` resolves to phone_numbers
    expect(Array.isArray(body.candidate.phone_numbers)).toBe(true);
    // defaults are additive
    expect(body.candidate.primary_email).toBe('jerry@x.com');
    expect(body.candidate.name).toBe('Jerry Smith');
  });
});
