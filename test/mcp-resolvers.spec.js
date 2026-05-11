import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import {
  resolveCandidate,
  resolveJob,
  resolveStage,
  resolveOwner,
} from '../src/mcp/resolvers.js';

const originalFetch = globalThis.fetch;

/**
 * Mock globalThis.fetch to handle the live RF /candidate/get call that
 * resolveCandidate now makes after id resolution. Returns the seeded
 * candidate body keyed by id-from-the-URL; tests can compose richer fixtures
 * by passing in their own fetch mock instead.
 */
function mockRFCandidateGet(bodiesById) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/candidate/get')) {
      const m = u.match(/[?&]id=(\d+)/);
      const id = m ? Number(m[1]) : NaN;
      const body = bodiesById.get(id);
      if (!body) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ candidate: body }), { status: 200 });
    }
    throw new Error('unexpected fetch: ' + u);
  });
}

const insertCandidate = async (id, name, opts = {}) => {
  // Seed BOTH the legacy `candidates` (for legacy-table reads still in
  // some adjacent test paths, e.g. resolver disambiguation pre-migration)
  // AND the new `candidates_v2` (the thin cache with snapshot columns
  // current_title_at_cache_time / current_company_at_cache_time, which
  // resolveCandidate now reads for disambiguation hydration).
  await env.RF_MCP_CACHE.prepare(
    `INSERT INTO candidates (id, body, name, current_organization, current_title, last_activity_at, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      JSON.stringify({ id, name, ...(opts.body ?? {}) }),
      name,
      opts.org ?? null,
      opts.title ?? null,
      opts.last_activity_at ?? null,
      new Date().toISOString(),
    )
    .run();
  const addedMs = opts.last_activity_at ? Date.parse(opts.last_activity_at) : Date.now();
  await env.RF_MCP_CACHE.prepare(
    `INSERT OR IGNORE INTO candidates_v2
       (id, name, linkedin_profile, added_time_ms,
        current_title_at_cache_time, current_company_at_cache_time, cached_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, name, opts.linkedin_profile ?? null, addedMs,
      opts.title ?? null, opts.org ?? null, Date.now(),
    )
    .run();
};

const insertJob = async (id, name, client = null, isOpen = 1) => {
  // Seed BOTH the legacy `jobs` table (some tests still reference its
  // `is_open` semantics in their fixtures) AND the new `jobs_v2` thin cache
  // (the post-migration read path).  Per spec rev 5 the v2 schema does not
  // store `is_open` — it's mutable and lives on RF. The legacy "closed jobs
  // excluded from fuzzy" behaviour is preserved here only because the
  // resolver test fixture seeded the legacy table; under the new schema
  // closed jobs are NOT distinguishable from open at the cache layer.
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, JSON.stringify({ id, name }), name, client, isOpen, new Date().toISOString())
    .run();
  // jobs_v2 ignores `isOpen` entirely (mutable; live on RF). All seeded jobs
  // are visible to fuzzy resolution post-migration; tests that exercised the
  // open-only filter now need to opt in via explicit numeric ids.
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT OR IGNORE INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, name, client, Date.now(), Date.now())
    .run();
};

const setSyncStateVersion = async (v) => {
  await env.RF_MCP_CACHE
    .prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)" +
        ' ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(v)
    .run();
};

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  resetSnapshot();
  await setSyncStateVersion(new Date().toISOString());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('resolveCandidate', () => {
  it('numeric id → live-fetches body from RF', async () => {
    await insertCandidate(42, 'Jerry Smith');
    mockRFCandidateGet(new Map([[42, { id: 42, name: 'Jerry Smith' }]]));
    const r = await resolveCandidate(env, 42);
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(42);
    expect(r.value.name).toBe('Jerry Smith');
  });

  it('numeric string id → live-fetches body from RF', async () => {
    await insertCandidate(42, 'Jerry Smith');
    mockRFCandidateGet(new Map([[42, { id: 42, name: 'Jerry Smith' }]]));
    const r = await resolveCandidate(env, '42');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(42);
  });

  it('unknown numeric id → not_found (no RF call)', async () => {
    globalThis.fetch = vi.fn();
    const r = await resolveCandidate(env, 999);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fuzzy unique → live-fetches winner body', async () => {
    await insertCandidate(1, 'Jane Doe');
    await insertCandidate(2, 'Bob Smith');
    await insertCandidate(3, 'Alice Jones');
    mockRFCandidateGet(new Map([[1, { id: 1, name: 'Jane Doe' }]]));
    const r = await resolveCandidate(env, 'Jane Doe');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(1);
  });

  it('fuzzy ambiguous → returns options with org+title context', async () => {
    await insertCandidate(1, 'Jerry Doe', { org: 'Acme', title: 'AE' });
    await insertCandidate(2, 'Jerry Park', { org: 'Globex', title: 'CSM' });
    const r = await resolveCandidate(env, 'Jerry');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.kind).toBe('candidate');
    expect(r.options.length).toBeGreaterThanOrEqual(2);
    const ids = r.options.map((o) => o.id).sort();
    expect(ids).toEqual([1, 2]);
    const jerryDoe = r.options.find((o) => o.id === 1);
    expect(jerryDoe.current_organization).toBe('Acme');
    expect(jerryDoe.current_title).toBe('AE');
    expect(r.hint).toMatch(/multiple/i);
  });

  it('fuzzy no match → not_found', async () => {
    await insertCandidate(1, 'Alice Jones');
    const r = await resolveCandidate(env, 'qzx');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });

  it('empty / null input → not_found', async () => {
    expect((await resolveCandidate(env, '')).reason).toBe('not_found');
    expect((await resolveCandidate(env, null)).reason).toBe('not_found');
    expect((await resolveCandidate(env, undefined)).reason).toBe('not_found');
  });
});

describe('resolveJob', () => {
  it('numeric id → loads job', async () => {
    await insertJob(100, 'Enterprise AE', 'Acme');
    const r = await resolveJob(env, 100);
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('numeric string id → loads job', async () => {
    await insertJob(100, 'Enterprise AE', 'Acme');
    const r = await resolveJob(env, '100');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('unknown id → not_found', async () => {
    const r = await resolveJob(env, 999);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });

  it('fuzzy unique → loads job', async () => {
    await insertJob(100, 'Enterprise AE', 'Acme');
    await insertJob(200, 'Customer Success Manager', 'Globex');
    const r = await resolveJob(env, 'Enterprise AE');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('canonicalises acronyms ("Eon SE" matches "Eon Sales Engineer")', async () => {
    await insertJob(100, 'Sales Engineer', 'Eon');
    await insertJob(200, 'Account Executive', 'Other');
    const r = await resolveJob(env, 'Eon SE');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('extra-target-token penalty: "SE" wins outright over SEM / SSE', async () => {
    // Real recruiter pain point — historical bug had `SE` returning all of
    // these as ambiguous options. The scorer's extra-token penalty is what
    // resolves this without an alias dictionary.
    await insertJob(100, 'Sales Engineer', 'Eon');
    await insertJob(200, 'Sales Engineering Manager', 'Eon');
    await insertJob(300, 'Senior Support Engineer', 'Eon');
    const r = await resolveJob(env, 'Eon SE');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('two SE-acronym jobs at same company → legitimate ambiguity', async () => {
    // Sales Engineer and Solutions Engineer both canonicalise to "se" — same
    // score, same company → genuine ambiguity that should reach the user.
    await insertJob(100, 'Sales Engineer', 'Eon');
    await insertJob(200, 'Solutions Engineer', 'Eon');
    const r = await resolveJob(env, 'Eon SE');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.options).toHaveLength(2);
  });

  it('closed jobs ARE visible in fuzzy resolution post-thin-cache (is_open is live, not cached)', async () => {
    // Spec rev 5: jobs_v2 doesn't store is_open (mutable — lives on RF only).
    // A name-unique closed job in cache now resolves to that job. Recruiters
    // who want to exclude closed jobs must either know the open job's id or
    // rely on the live `/job/list` filter from a higher layer.
    await insertJob(100, 'Old Sales Engineer', 'Eon', 0);
    const r = await resolveJob(env, 'Old Sales Engineer');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('closed job accessible by numeric id', async () => {
    // Numeric ids always work — no fuzzy filter applied.
    await insertJob(100, 'Old Sales Engineer', 'Eon', 0);
    const r = await resolveJob(env, 100);
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('two same-named jobs with one closed → genuine ambiguity at the cache layer', async () => {
    // Without is_open in cache, the resolver cannot favour the open sibling
    // automatically. Both score equally → ambiguous. Recruiters who hit this
    // pass the explicit numeric id.
    await insertJob(100, 'Sales Engineer', 'Eon', 0);
    await insertJob(200, 'Sales Engineer', 'Eon', 1);
    const r = await resolveJob(env, 'Eon SE');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
  });

  it('matches client company name', async () => {
    await insertJob(100, 'Enterprise AE', 'Nominal');
    await insertJob(200, 'Enterprise AE', 'Other');
    const r = await resolveJob(env, 'Nominal');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(100);
  });

  it('fuzzy ambiguous → returns options', async () => {
    await insertJob(100, 'Enterprise AE', 'Acme');
    await insertJob(200, 'Enterprise AE', 'Globex');
    const r = await resolveJob(env, 'Enterprise AE');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.kind).toBe('job');
    expect(r.options).toHaveLength(2);
    expect(r.options[0]).toHaveProperty('client_company_name');
  });

  it('restrictTo limits search to a candidate-job-link list', async () => {
    await insertJob(100, 'Enterprise AE', 'Acme');
    await insertJob(200, 'PM Lead', 'Globex');
    const restrict = [
      { job_id: 100, job_name: 'Enterprise AE', stage_name: 'Sourced', stages: [{ id: 1, name: 'Sourced' }] },
    ];
    const r = await resolveJob(env, 'Enterprise', { restrictTo: restrict });
    expect(r.ok).toBe(true);
    // should return the original link entry (with stages, etc.)
    expect(r.value.job_id).toBe(100);
    expect(r.value.stages).toBeDefined();
  });

  it('restrictTo + numeric id', async () => {
    const restrict = [
      { job_id: 100, job_name: 'Enterprise AE', stage_name: 'Sourced' },
    ];
    const r = await resolveJob(env, 100, { restrictTo: restrict });
    expect(r.ok).toBe(true);
    expect(r.value.job_id).toBe(100);
  });

  it('restrictTo with no match → not_found', async () => {
    const restrict = [
      { job_id: 100, job_name: 'Enterprise AE', stage_name: 'Sourced' },
    ];
    const r = await resolveJob(env, 999, { restrictTo: restrict });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });
});

describe('resolveStage', () => {
  const stages = [
    { id: 1, name: 'Sourced' },
    { id: 2, name: 'Replied' },
    { id: 3, name: 'Call Booked' },
    { id: 4, name: '1st Interview' },
    { id: 5, name: '2nd Interview' },
  ];

  it('numeric id → matches', () => {
    const r = resolveStage(2, stages);
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Replied');
  });

  it('exact name match (case-insensitive)', () => {
    const r = resolveStage('replied', stages);
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(2);
  });

  it('fuzzy "call booked" → Call Booked', () => {
    const r = resolveStage('call booked', stages);
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Call Booked');
  });

  it('fuzzy "1st" → 1st Interview', () => {
    const r = resolveStage('1st', stages);
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('1st Interview');
  });

  it('ambiguous "Interview" → both 1st + 2nd interview', () => {
    const r = resolveStage('Interview', stages);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.kind).toBe('stage');
    const names = r.options.map((o) => o.name).sort();
    expect(names).toContain('1st Interview');
    expect(names).toContain('2nd Interview');
  });

  it('unknown stage → not_found', () => {
    const r = resolveStage('xqz123', stages);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });

  it('unknown numeric id → not_found', () => {
    const r = resolveStage(999, stages);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });
});

describe('resolveOwner', () => {
  it('numeric id passes through', async () => {
    const r = await resolveOwner(env, 900001);
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(900001);
  });

  it('numeric string id passes through', async () => {
    const r = await resolveOwner(env, '900001');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(900001);
  });

  it('users.js fast-path: "Joel" → 900001', async () => {
    const r = await resolveOwner(env, 'Joel');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(900001);
  });

  it('users.js fast-path: "Bob" alias → Bob', async () => {
    const r = await resolveOwner(env, 'Bob');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(900003);
  });

  it('falls back to sync_state.users when fast-path misses', async () => {
    await env.RF_MCP_CACHE
      .prepare("INSERT INTO sync_state (key, value) VALUES ('users', ?)")
      .bind(
        JSON.stringify([
          { id: 9001, first_name: 'Casey', last_name: 'Stranger', email: 'casey@x.com' },
          { id: 9002, first_name: 'Drew', last_name: 'Outsider', email: 'drew@x.com' },
        ]),
      )
      .run();
    const r = await resolveOwner(env, 'Casey Stranger');
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe(9001);
  });

  it('not_found when no users cached and not in users.js', async () => {
    const r = await resolveOwner(env, 'Casey Stranger');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });
});
