import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-log-interview', {
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('/mcp/candidate-log-interview', () => {
  it('creates RF activity, returns ok + outlook_url + next_step', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.activity.id).toBe(999);
    expect(b.activity.candidate_id).toBe(42);
    expect(b.activity.kind).toBe('1st Interview');
    expect(b.next_step).toMatch(/calendar/i);
    expect(b.outlook_url).toMatch(/^https:\/\/outlook\.live\.com\/calendar/);
    // Joel's calendarMode is 'outlook' so no gcal_hint by default.
    expect(b.gcal_hint).toBeUndefined();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = globalThis.fetch.mock.calls[0];
    expect(String(calledUrl)).toContain('/custom-activity/create');
    const sent = JSON.parse(calledOpts.body);
    expect(sent).toMatchObject({
      candidate_id: 42,
      activity_type_id: 1003,
      activity_user_id: 900001,
    });
    expect(typeof sent.start_time).toBe('string');
    expect(typeof sent.end_time).toBe('string');
  });

  it('rejects without start_time (400)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
    });
    expect(r.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown candidate id', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 9999,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uses interview activity_type_id from sync_state.activity_types when present', async () => {
    await env.RF_MCP_CACHE.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('activity_types', ?)"
    ).bind(JSON.stringify([
      { id: 1002, name: 'Cold Call' },
      { id: 4242, name: 'Interview' },
    ])).run();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.activity_type_id).toBe(4242);
  });

  it('falls back to 1003 when sync_state.activity_types is unset', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.activity_type_id).toBe(1003);
  });

  it('outlook_url does NOT include the candidate email (recruiter-only block)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    const b = await r.json();
    expect(b.outlook_url).not.toContain('t%40x.com');
    expect(b.outlook_url).not.toContain('t@x.com');
    expect(new URL(b.outlook_url).searchParams.has('to')).toBe(false);
  });

  it('fuzzy candidate name resolves uniquely', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Test Candidate',
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.activity.candidate_id).toBe(42);
  });

  it('numeric candidate id as string still works', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: '42',
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
  });

  it('ambiguous fuzzy candidate name → needs_disambiguation kind=candidate', async () => {
    // Use distinct names that the fuzzy scorer treats as similarly-good
    // matches for "Jordan" — neither is an exact match.
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      42, JSON.stringify({ id: 42, name: 'Jordan Chen' }),
      'Jordan Chen', 'Acme', 'AE', new Date().toISOString()
    ).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      43, JSON.stringify({ id: 43, name: 'Jordan Patel' }),
      'Jordan Patel', 'Globex', 'CSM', new Date().toISOString()
    ).run();
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Jordan',
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('candidate');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('post-narrow: two Jordans, only one is on the specified job → auto-commits', async () => {
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    // Jordan Chen is on job 100; Jordan Patel is on job 999. Caller asks for
    // log-interview on job 100 — post-narrow should drop Patel and commit.
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      42, JSON.stringify({
        id: 42, name: 'Jordan Chen',
        jobs: [{ job_id: 100, job_name: 'Eng', disqualified: false }],
      }),
      'Jordan Chen', 'Acme', 'AE', new Date().toISOString()
    ).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      43, JSON.stringify({
        id: 43, name: 'Jordan Patel',
        jobs: [{ job_id: 999, job_name: 'PM', disqualified: false }],
      }),
      'Jordan Patel', 'Globex', 'CSM', new Date().toISOString()
    ).run();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 555 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Jordan',
      job: 'Eng',
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.activity.candidate_id).toBe(42);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('post-narrow: two Jordans, neither on the specified job → 400', async () => {
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      42, JSON.stringify({
        id: 42, name: 'Jordan Chen',
        jobs: [{ job_id: 999, job_name: 'PM', disqualified: false }],
      }),
      'Jordan Chen', 'Acme', 'AE', new Date().toISOString()
    ).run();
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      43, JSON.stringify({
        id: 43, name: 'Jordan Patel',
        jobs: [{ job_id: 888, job_name: 'CSM Lead', disqualified: false }],
      }),
      'Jordan Patel', 'Globex', 'CSM', new Date().toISOString()
    ).run();
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Jordan',
      job: 'Eng',
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('candidate_id + job_id bypass fuzzy resolvers', async () => {
    // Re-seed candidate 42 with a jobs array so job_id: 100 passes the filter.
    await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, cached_at) VALUES (42, ?, ?, ?)'
    ).bind(
      JSON.stringify({
        id: 42, name: 'Test Candidate', primary_email: 't@x.com',
        jobs: [{ job_id: 100, job_name: 'Eng', disqualified: false }],
      }),
      'Test Candidate',
      new Date().toISOString(),
    ).run();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, id: 999 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate_id: 42,
      job_id: 100,
      summary: 'Quick chat',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.activity.candidate_id).toBe(42);
  });

  it('returns 502 if RF activity-create fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('rf went boom', { status: 500 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 42,
      kind: '1st Interview',
      start_time: '2026-05-08T10:00:00+01:00',
    });
    expect(r.status).toBe(502);
    const b = await r.json();
    expect(b.error).toContain('500');
  });
});
