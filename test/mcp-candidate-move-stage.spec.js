import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-move-stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

/**
 * Build a fetch mock that:
 *   • serves `/candidate/get?id=<n>` from `bodiesById` (a Map<number, object>)
 *   • serves `/candidate/move-to-stage` with `moveResponse` (default ok)
 *
 * `moveResponse.status` allows simulating RF failures (500/429/etc.).
 *
 * Move-stage handlers live-fetch the candidate body from RF after id
 * resolution, so every test that previously seeded only the legacy
 * `candidates` body must now also expose the body via this mock.
 */
function mockMoveStage(bodiesById, moveResponse = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/candidate/get')) {
      const m = u.match(/[?&]id=(\d+)/);
      const id = m ? Number(m[1]) : 0;
      const body = bodiesById.get(id);
      if (!body) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ candidate: body }), { status: 200 });
    }
    if (u.includes('/candidate/move-to-stage')) {
      const status = moveResponse.status ?? 200;
      const body = moveResponse.body ?? JSON.stringify({ ok: true });
      const headers = moveResponse.headers ?? {};
      return new Response(body, { status, headers });
    }
    throw new Error('unexpected fetch: ' + u);
  });
}

/**
 * Standard seeded body for candidate 42 used across most tests.
 */
const JERRY_42_BODY = {
  id: 42, name: 'Jerry Smith',
  jobs: [{
    job_id: 100, job_name: 'Eng', stage_id: 1, stage_name: 'Sourced',
    disqualified: false,
    stages: [
      { id: 1, name: 'Sourced' },
      { id: 2, name: 'Replied' },
      { id: 3, name: 'Call Booked' },
      { id: 4, name: '1st Interview' },
      { id: 5, name: '2nd Interview' },
    ],
  }],
};

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  resetSnapshot();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (?, ?, ?, ?)'
  ).bind(42, JSON.stringify({
    id: 42, name: 'Jerry Smith',
    jobs: [{
      job_id: 100, job_name: 'Eng', stage_id: 1, stage_name: 'Sourced',
      disqualified: false,
      stages: [
        { id: 1, name: 'Sourced' },
        { id: 2, name: 'Replied' },
        { id: 3, name: 'Call Booked' },
        { id: 4, name: '1st Interview' },
        { id: 5, name: '2nd Interview' },
      ],
    }],
  }), 'Jerry Smith', new Date().toISOString()).run();
  await env.RF_MCP_CACHE.prepare(
    'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
  ).bind(42, 'Jerry Smith', null, Date.now(), Date.now()).run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('/mcp/candidate-move-stage', () => {
  it('round-trips to RF and returns success with from/to stage', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;

    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.moved.candidate_id).toBe(42);
    expect(b.moved.candidate_name).toBe('Jerry Smith');
    expect(b.moved.job_id).toBe(100);
    expect(b.moved.from_stage).toBe('Sourced');
    expect(b.moved.to_stage).toBe('Replied');

    const moveCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/candidate/move-to-stage'));
    expect(moveCall).toBeDefined();
    const sent = JSON.parse(moveCall[1].body);
    expect(sent).toMatchObject({
      id: 42,
      job_id: 100,
      stage: { id: 2, name: 'Replied' },
      user_id: 900001,  // Joel's rfUserId
    });
  });

  it('returns disambiguation when candidate has multiple non-DQ jobs and no job specified', async () => {
    const twoJobBody = {
      id: 42, name: 'Jerry Smith',
      jobs: [
        { job_id: 100, job_name: 'Eng', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
        { job_id: 200, job_name: 'PM', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
      ],
    };
    const fetchMock = mockMoveStage(new Map([[42, twoJobBody]]));
    globalThis.fetch = fetchMock;

    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('job');
    expect(b.options).toHaveLength(2);
    expect(b.options[0]).toMatchObject({ job_id: 100, job_name: 'Eng' });
    expect(b.options[1]).toMatchObject({ job_id: 200, job_name: 'PM' });
    // No move-to-stage call — only the candidate/get to inspect jobs.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/candidate/move-to-stage'))).toBe(false);
  });

  it('returns 404 for unknown candidate id', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 999, stage: 'Replied' });
    expect(r.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 for stage not found on job', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'NotARealStage' });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toContain('NotARealStage');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/candidate/move-to-stage'))).toBe(false);
  });

  it('fuzzy candidate name resolves uniquely and round-trips to RF', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 'Jerry Smith', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.moved.candidate_id).toBe(42);
  });

  it('numeric candidate id passed as string still works', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: '42', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.candidate_id).toBe(42);
  });

  it('ambiguous fuzzy candidate name returns needs_disambiguation kind=candidate', async () => {
    // Insert a second Jerry to force ambiguity. With post-narrow, the second
    // Jerry needs a job + Replied stage so it produces a valid tuple too.
    await env.RF_MCP_CACHE.prepare(
      `INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms,
        current_title_at_cache_time, current_company_at_cache_time, cached_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(43, 'Jerry Park', null, Date.now(), 'CSM', 'Globex', Date.now()).run();
    const jerryParkBody = {
      id: 43, name: 'Jerry Park',
      jobs: [{
        job_id: 200, job_name: 'CSM Lead', stage_id: 1, stage_name: 'Sourced',
        disqualified: false,
        stages: [
          { id: 1, name: 'Sourced' },
          { id: 2, name: 'Replied' },
        ],
      }],
    };
    const fetchMock = mockMoveStage(new Map([
      [42, JERRY_42_BODY],
      [43, jerryParkBody],
    ]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 'Jerry', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('candidate');
    expect(b.options.length).toBeGreaterThanOrEqual(2);
    expect(b.options[0]).toHaveProperty('current_organization');
    // No move-to-stage on disambiguation.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/candidate/move-to-stage'))).toBe(false);
  });

  it('post-narrow: two Jerries but only one is on the specified job → auto-commits', async () => {
    await env.RF_MCP_CACHE.prepare(
      'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(43, 'Jerry Park', null, Date.now(), Date.now()).run();
    const jerryParkBody = {
      id: 43, name: 'Jerry Park',
      jobs: [{
        job_id: 300, job_name: 'Sales Lead', stage_id: 1, stage_name: 'Sourced',
        disqualified: false,
        stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
      }],
    };
    const fetchMock = mockMoveStage(new Map([
      [42, JERRY_42_BODY],
      [43, jerryParkBody],
    ]));
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Jerry',
      job: 'Eng',
      stage: 'Replied',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.moved.candidate_id).toBe(42);
    expect(b.moved.job_id).toBe(100);
  });

  it('post-narrow: two Jerries on differently-named jobs, both share Replied → kind=candidate options carry job context', async () => {
    await env.RF_MCP_CACHE.prepare(
      `INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms,
        current_title_at_cache_time, current_company_at_cache_time, cached_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(43, 'Jerry Park', null, Date.now(), 'CSM', 'Globex', Date.now()).run();
    const jerryParkBody = {
      id: 43, name: 'Jerry Park',
      jobs: [{
        job_id: 300, job_name: 'CSM Lead', stage_id: 1, stage_name: 'Sourced',
        disqualified: false,
        stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
      }],
    };
    const fetchMock = mockMoveStage(new Map([
      [42, JERRY_42_BODY],
      [43, jerryParkBody],
    ]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 'Jerry', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('candidate');
    expect(b.options).toHaveLength(2);
    for (const opt of b.options) {
      expect(opt).toHaveProperty('id');
      expect(opt).toHaveProperty('name');
      expect(opt).toHaveProperty('current_organization');
      expect(opt).toHaveProperty('job_name');
      expect(opt).toHaveProperty('to_stage');
    }
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/candidate/move-to-stage'))).toBe(false);
  });

  it('post-narrow: single candidate, single job, ambiguous stage → kind=stage', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    const names = b.options.map((o) => o.name).sort();
    expect(names).toContain('1st Interview');
    expect(names).toContain('2nd Interview');
  });

  it('fuzzy stage name resolves ("call booked" → Call Booked)', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'call booked' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.to_stage).toBe('Call Booked');
  });

  it('fuzzy stage name partial match ("1st" → 1st Interview)', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: '1st' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.to_stage).toBe('1st Interview');
  });

  it('ambiguous stage name returns needs_disambiguation kind=stage', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    const names = b.options.map((o) => o.name).sort();
    expect(names).toContain('1st Interview');
    expect(names).toContain('2nd Interview');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/candidate/move-to-stage'))).toBe(false);
  });

  it('fuzzy job name resolves against the candidate jobs[]', async () => {
    const twoJobBody = {
      id: 42, name: 'Jerry Smith',
      jobs: [
        { job_id: 100, job_name: 'Enterprise AE', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
        { job_id: 200, job_name: 'CSM Lead', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
      ],
    };
    const fetchMock = mockMoveStage(new Map([[42, twoJobBody]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, job: 'Enterprise AE', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.job_id).toBe(100);
  });

  it('candidate_id + job_id + stage_id = direct commit (still live-fetches body to validate tuple)', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, job_id: 100, stage_id: 2 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.moved.candidate_id).toBe(42);
    expect(body.moved.to_stage).toBe('Replied');
  });

  it('candidate_id alone falls through to fuzzy job/stage path', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, stage: 'replied' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.moved.to_stage).toBe('Replied');
  });

  it('candidate_id with non-existent id returns 404', async () => {
    // No candidates_v2 row for 99999 → thin sanity check fails before RF.
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 99999, job_id: 100, stage_id: 2 });
    expect(r.status).toBe(404);
  });

  it('candidate_id + wrong job_id returns 404', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, job_id: 999, stage_id: 2 });
    expect(r.status).toBe(404);
  });

  it('candidate_id + job_id + bad stage_id returns 404', async () => {
    const fetchMock = mockMoveStage(new Map([[42, JERRY_42_BODY]]));
    globalThis.fetch = fetchMock;
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, job_id: 100, stage_id: 9999 });
    expect(r.status).toBe(404);
  });
});
