import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-add-note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

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
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (42, ?, ?, ?)'
  ).bind(
    JSON.stringify({ id: 42, name: 'Test Candidate', primary_email: 't@x.com' }),
    'Test Candidate',
    new Date().toISOString(),
  ).run();
  await env.RF_MCP_CACHE.prepare(
    'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
  ).bind(42, 'Test Candidate', null, Date.now(), Date.now()).run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('/mcp/candidate-add-note', () => {
  it('happy path: numeric candidate + plain markdown → live-fetches, posts HTML, returns ok', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: { id: 42, name: 'Test Candidate', primary_email: 't@x.com' },
        }), { status: 200 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response(JSON.stringify({ id: 555 }), { status: 200 });
      }
      throw new Error('unexpected fetch: ' + u);
    });
    globalThis.fetch = fetchMock;

    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      note: 'spoke to him about the SE role',
    });

    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true });

    const noteCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/candidate/notes/add'));
    const sent = JSON.parse(noteCall[1].body);
    expect(sent.id).toBe(42);
    expect(sent.created_by).toBe(900001); // Joel's rfUserId from the test users migration
    expect(sent.mentions).toEqual([]);
    expect(sent.value).toContain('spoke to him about the SE role');
    // marked wraps plain prose in <p>
    expect(sent.value).toMatch(/^<p>/);
  });

  it('rejects when note is missing (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('note is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects when note is whitespace-only (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      note: '   \n  ',
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('note is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects when candidate is missing (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      note: 'a perfectly valid note body',
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('candidate is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns lean no_candidate envelope for an unknown candidate id', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 9999,
      note: 'whatever',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ ok: false, kind: 'no_candidate' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fuzzy candidate name resolves uniquely → live-fetches body then commits the note', async () => {
    // Live-fetch returns the full RF body; then the note add posts.
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: { id: 42, name: 'Test Candidate', primary_email: 't@x.com' },
        }), { status: 200 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response(JSON.stringify({ id: 777 }), { status: 200 });
      }
      throw new Error('unexpected fetch: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Test Candidate',
      note: 'fuzzy single match',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true });
    // The notes/add call carries candidate 42.
    const noteCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/candidate/notes/add'));
    const sent = JSON.parse(noteCall[1].body);
    expect(sent.id).toBe(42);
  });

  it('numeric candidate id as string still works', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: { id: 42, name: 'Test Candidate' },
        }), { status: 200 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response(JSON.stringify({ id: 555 }), { status: 200 });
      }
      throw new Error('unexpected fetch: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: '42',
      note: 'string id path',
    });
    expect(r.status).toBe(200);
  });

  it('ambiguous fuzzy candidate name → needs_disambiguation kind=candidate (Phase 2 may call /candidate/get)', async () => {
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
    // Disambiguation envelope hydrates current_title / current_organization
    // from the v2 snapshot columns (display hints, never live).
    await env.RF_MCP_CACHE.prepare(
      `INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms,
        current_title_at_cache_time, current_company_at_cache_time, cached_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(42, 'Jordan Chen', null, Date.now(), 'AE', 'Acme', Date.now()).run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms,
        current_title_at_cache_time, current_company_at_cache_time, cached_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(43, 'Jordan Patel', null, Date.now(), 'CSM', 'Globex', Date.now()).run();
    resetSnapshot();
    // Phase 2 fan-out fires when the top-K is genuinely ambiguous — stub
    // /candidate/get so the rerank reads valid bodies. Neither candidate
    // has stage progression beyond Sourced, so neither gets a recency
    // boost and the ambiguity survives.
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        const m = u.match(/id=(\d+)/);
        const id = m ? Number(m[1]) : 0;
        return new Response(JSON.stringify({ candidate: { id, name: `Jordan ${id}`, jobs: [] } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Jordan',
      note: 'should disambiguate',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('candidate');
    expect(b.options).toHaveLength(2);
    expect(b.options.map((o) => o.id).sort()).toEqual([42, 43]);
    expect(b.options.every((o) => 'current_organization' in o)).toBe(true);
    expect(b.options.every((o) => 'current_title' in o)).toBe(true);
    // Snapshot values flowed through:
    const chen = b.options.find((o) => o.id === 42);
    expect(chen.current_organization).toBe('Acme');
    expect(chen.current_title).toBe('AE');
    // Phase 2 fan-out may hit /candidate/get — load-bearing invariant is
    // that we never hit /candidate/search on this path.
    for (const [url] of globalThis.fetch.mock.calls) {
      const u = typeof url === 'string' ? url : url.url;
      expect(u).not.toMatch(/\/candidate\/search/);
    }
  });

  it('ambiguous candidate + job auto-narrows to single survivor → commits', async () => {
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
    await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
    await env.RF_MCP_CACHE.exec('DELETE FROM jobs_v2');
    // Two Jordans; only id=42 is on the Eon SE job. Bodies are live-fetched
    // from RF (the legacy candidates.body blob is gone post-cutover).
    await env.RF_MCP_CACHE.prepare(
      'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(42, 'Jordan Chen', null, Date.now(), Date.now()).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT OR IGNORE INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(43, 'Jordan Patel', null, Date.now(), Date.now()).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms) VALUES (100, ?, ?, 1, 1)'
    ).bind('Eon SE', 'Eon').run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms) VALUES (200, ?, ?, 1, 1)'
    ).bind('Acme CSM', 'Acme').run();
    resetSnapshot();

    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        const m = u.match(/[?&]id=(\d+)/);
        const id = m ? Number(m[1]) : 0;
        if (id === 42) {
          return new Response(JSON.stringify({
            candidate: {
              id: 42, name: 'Jordan Chen',
              jobs: [{ job_id: 100, job_name: 'Eon SE', disqualified: false, stages: [], stage_name: 'Sourced' }],
            },
          }), { status: 200 });
        }
        if (id === 43) {
          return new Response(JSON.stringify({
            candidate: {
              id: 43, name: 'Jordan Patel',
              jobs: [{ job_id: 200, job_name: 'Acme CSM', disqualified: false, stages: [], stage_name: 'Sourced' }],
            },
          }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response(JSON.stringify({ id: 888 }), { status: 200 });
      }
      throw new Error('unexpected: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Jordan',
      job: 'Eon SE',
      note: 'auto-narrowed via job filter',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true });
    // Confirm the auto-narrow picked the Eon-SE Jordan (id 42).
    const noteCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/candidate/notes/add'));
    const sent = JSON.parse(noteCall[1].body);
    expect(sent.id).toBe(42);
  });

  it('job filter with no surviving candidate → 400 no-match, no RF notes/add call', async () => {
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
    await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
    await env.RF_MCP_CACHE.exec('DELETE FROM jobs_v2');
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(42, 'Test Candidate', null, Date.now(), Date.now()).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms) VALUES (100, ?, ?, 1, 1)'
    ).bind('Eon SE', 'Eon').run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms) VALUES (300, ?, ?, 1, 1)'
    ).bind('Globex SRE', 'Globex').run();
    resetSnapshot();

    // Live-fetch returns the candidate with only Eon SE — Globex SRE filter
    // drops it from candidateOptions and we land in the "no candidate matches
    // the given filters" branch BEFORE any /candidate/notes/add fires.
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: {
            id: 42, name: 'Test Candidate',
            jobs: [{ job_id: 100, job_name: 'Eon SE', disqualified: false, stages: [], stage_name: 'Sourced' }],
          },
        }), { status: 200 });
      }
      throw new Error('unexpected: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      job: 'Globex SRE', // candidate 42 has no link to job 300
      note: 'should be filtered out',
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('no candidate matches the given filters');
    // notes/add must not have fired.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/candidate/notes/add'))).toBe(false);
  });

  it('candidate_id + job_id short-circuit: bypasses fuzzy, commits', async () => {
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
    await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
    await env.RF_MCP_CACHE.exec('DELETE FROM jobs_v2');
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(42, 'Test Candidate', null, Date.now(), Date.now()).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms) VALUES (100, ?, ?, 1, 1)'
    ).bind('Eon SE', 'Eon').run();
    resetSnapshot();

    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: {
            id: 42, name: 'Test Candidate',
            jobs: [{ job_id: 100, job_name: 'Eon SE', disqualified: false, stages: [], stage_name: 'Sourced' }],
          },
        }), { status: 200 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response(JSON.stringify({ id: 111 }), { status: 200 });
      }
      throw new Error('unexpected: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate_id: 42,
      job_id: 100,
      note: 'short-circuit path',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true });
    const noteCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/candidate/notes/add'));
    const sent = JSON.parse(noteCall[1].body);
    expect(sent.id).toBe(42);
  });

  it('RF notes/add non-2xx → HTTP 200 with lean rf_unavailable envelope', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: { id: 42, name: 'Test Candidate' },
        }), { status: 200 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response('upstream blew up', { status: 500 });
      }
      throw new Error('unexpected: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      note: 'RF will reject',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('rf_unavailable');
    expect(b.recoverable).toBe(true);
    expect(b.error).toMatch(/RF notes\/add failed/);
  });

  it('attribution always comes from the JWT-resolved consultant', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: { id: 42, name: 'Test Candidate' },
        }), { status: 200 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      throw new Error('unexpected: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      note: 'attribution check',
      user: 999999, // attempt to override — should be ignored (no such field on the surface)
    });
    expect(r.status).toBe(200);
    const noteCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/candidate/notes/add'));
    const sent = JSON.parse(noteCall[1].body);
    // Joel's rfUserId from the test users migration is 900001.
    expect(sent.created_by).toBe(900001);
  });

  it('markdown bold + line break + list renders in the RF payload', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/get')) {
        return new Response(JSON.stringify({
          candidate: { id: 42, name: 'Test Candidate' },
        }), { status: 200 });
      }
      if (u.includes('/candidate/notes/add')) {
        return new Response(JSON.stringify({ id: 222 }), { status: 200 });
      }
      throw new Error('unexpected: ' + u);
    });
    globalThis.fetch = fetchMock;
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      note: '**summary**\nspoke to him about:\n* SE role\n* timing',
    });
    expect(r.status).toBe(200);
    const noteCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/candidate/notes/add'));
    const sent = JSON.parse(noteCall[1].body);
    expect(sent.value).toContain('<strong>summary</strong>');
    expect(sent.value).toMatch(/<br\s*\/?>/);
    expect(sent.value).toContain('<ul>');
    expect(sent.value).toContain('<li>SE role</li>');
    expect(sent.value).toContain('<li>timing</li>');
  });
});
