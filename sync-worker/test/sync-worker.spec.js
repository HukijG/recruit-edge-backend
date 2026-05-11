import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { tailSyncThin } from '../src/sync-worker.js';
import { applyMigration } from './helpers/migrate.js';

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
  // USERS_DB schema needs to exist for listConsultants — same pattern as users-d1-read.spec.
  await env.USERS_DB
    .prepare(`CREATE TABLE IF NOT EXISTS users (
      email          TEXT    PRIMARY KEY,
      rf_user_id     INTEGER NOT NULL,
      dialpad_id     TEXT    NOT NULL,
      first_name     TEXT    NOT NULL,
      calendar_mode  TEXT    NOT NULL DEFAULT 'outlook',
      aliases        TEXT,
      created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`).run();
  await env.USERS_DB.prepare("DELETE FROM users").run();
  globalThis.fetch = vi.fn();
});

function mockJSON(handlers /* (url, init) => Response-like */) {
  globalThis.fetch.mockImplementation(handlers);
}

describe('tailSyncThin', () => {
  it('writes new candidates from /candidate/search added_on filter and advances cursor', async () => {
    // Seed an old cursor so the candidate's added_time advances it (the
    // "never move backward" guard would otherwise pin to the cursor default).
    await env.RF_MCP_CACHE
      .prepare("INSERT INTO sync_state (key, value) VALUES ('last_candidates_added_cursor', '2024-01-01T00:00:00.000Z')")
      .run();

    mockJSON(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        return {
          ok: true, status: 200,
          json: async () => ({ data: [{ id: 1, name: 'Jane', added_time: '2024-06-01T12:00:00+0000' }] }),
          text: async () => '',
          headers: new Map(),
        };
      }
      if (u.includes('/job/list')) {
        return { ok: true, status: 200, json: async () => [], text: async () => '', headers: new Map() };
      }
      // No consultants seeded; calls subtask is a no-op.
      return { ok: true, status: 200, json: async () => ({ items: [], cursor: null }), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);

    const { results: cand } = await env.RF_MCP_CACHE
      .prepare('SELECT id FROM candidates_v2').all();
    expect(cand).toEqual([{ id: 1 }]);

    const cursorRow = await env.RF_MCP_CACHE
      .prepare("SELECT value FROM sync_state WHERE key='last_candidates_added_cursor'").first();
    expect(cursorRow.value).toBe('2024-06-01T12:00:00.000Z');
  });

  it('is idempotent on second tick with no API changes', async () => {
    // Seed an old cursor so RF rows are accepted on tick 1 (cursor must be
    // older than the rows' added_time for the never-backward guard).
    await env.RF_MCP_CACHE
      .prepare("INSERT INTO sync_state (key, value) VALUES ('last_candidates_added_cursor', '2024-01-01T00:00:00.000Z')")
      .run();

    const candPage = { ok: true, status: 200, headers: new Map(), text: async () => '',
      json: async () => ({ data: [{ id: 1, name: 'Jane', added_time: '2024-06-01T12:00:00+0000' }] }) };
    const emptyPage = { ok: true, status: 200, headers: new Map(), text: async () => '',
      json: async () => ({ data: [] }) };
    let candCallCount = 0;
    mockJSON(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        candCallCount++;
        return candCallCount <= 2 ? candPage : emptyPage;
      }
      if (u.includes('/job/list')) {
        return { ok: true, status: 200, json: async () => [], text: async () => '', headers: new Map() };
      }
      return { ok: true, status: 200, json: async () => ({ items: [], cursor: null }), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);
    await tailSyncThin(env);

    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates_v2').all();
    expect(results[0].n).toBe(1); // INSERT-OR-IGNORE absorbs the dupe
  });

  it('writes jobs from /job/list and seeds canonical_pipeline_json for new jobs', async () => {
    mockJSON(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '', headers: new Map() };
      }
      if (u.includes('/job/list')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => [{ id: 42, name: 'SWE', company: { name: 'Acme' }, created_time: '2024-01-15T09:00:00+0000' }],
        };
      }
      if (u.includes('/job/pipeline')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({ summary: [{ id: 1, name: 'Sourced', count: 0 }, { id: 2, name: 'Hired', count: 0 }], detail: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [], cursor: null }), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);

    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id, name, canonical_pipeline_json FROM jobs_v2 WHERE id = 42').all();
    expect(results[0].id).toBe(42);
    expect(results[0].name).toBe('SWE');
    const summary = JSON.parse(results[0].canonical_pipeline_json);
    expect(summary).toEqual([{ id: 1, name: 'Sourced', count: 0 }, { id: 2, name: 'Hired', count: 0 }]);
  });

  it('skips /job/pipeline fetch for already-known jobs (idempotent)', async () => {
    // Pre-seed a job in jobs_v2.
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO jobs_v2 (id, name, client_company_name, added_time_ms, canonical_pipeline_json, cached_at_ms)
       VALUES (42, 'SWE', 'Acme', 1, '[{"id":1,"name":"Sourced"}]', 1)`
    ).run();

    let pipelineCalled = 0;
    mockJSON(async (url) => {
      const u = String(url);
      if (u.includes('/job/pipeline')) pipelineCalled++;
      if (u.includes('/candidate/search')) return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '', headers: new Map() };
      if (u.includes('/job/list')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => [{ id: 42, name: 'SWE', company: { name: 'Acme' }, created_time: '2024-01-15T09:00:00+0000' }],
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [], cursor: null }), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);
    expect(pipelineCalled).toBe(0);
  });

  it('fans out calls per consultant from listConsultants', async () => {
    await env.USERS_DB.prepare(`INSERT INTO users (email, rf_user_id, dialpad_id, first_name)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
      .bind(
        'a@test.local', 1, '1111', 'A',
        'b@test.local', 2, '2222', 'B',
      ).run();

    let callsCallCount = 0;
    mockJSON(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '', headers: new Map() };
      if (u.includes('/job/list')) return { ok: true, status: 200, json: async () => [], text: async () => '', headers: new Map() };
      if (u.includes('/v2/call')) {
        callsCallCount++;
        const targetId = new URL(u).searchParams.get('target_id');
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({
            items: [{
              call_id: `c-${targetId}-1`,
              target: { id: targetId },
              contact: { id: 'shared_contact_pool_Company:X_uid_RF99' },
              date_started: 1717248000000,
              total_duration: 60_000,
              direction: 'outbound',
            }],
            cursor: null,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);

    expect(callsCallCount).toBe(2); // one per consultant
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id, target_dialpad_id FROM calls ORDER BY call_id').all();
    expect(results).toEqual([
      { call_id: 'c-1111-1', target_dialpad_id: '1111' },
      { call_id: 'c-2222-1', target_dialpad_id: '2222' },
    ]);
  });

  it('one subtask failure does not block others (Promise.allSettled semantics)', async () => {
    mockJSON(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        // Candidates subtask fails.
        return { ok: false, status: 500, text: async () => 'rf down', headers: new Map(), json: async () => ({}) };
      }
      if (u.includes('/job/list')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => [{ id: 99, name: 'OK', company: { name: 'X' }, created_time: '2024-01-15T09:00:00+0000' }],
        };
      }
      if (u.includes('/job/pipeline')) {
        return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ summary: [], detail: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [], cursor: null }), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);

    // Candidates failed; jobs subtask should still have written.
    const { results } = await env.RF_MCP_CACHE.prepare('SELECT id FROM jobs_v2').all();
    expect(results).toEqual([{ id: 99 }]);
  });

  it('one consultant failure does not block the others', async () => {
    await env.USERS_DB.prepare(`INSERT INTO users (email, rf_user_id, dialpad_id, first_name)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
      .bind(
        'a@test.local', 1, '1111', 'A',
        'b@test.local', 2, '2222', 'B',
      ).run();

    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '', headers: new Map() };
      if (u.includes('/job/list')) return { ok: true, status: 200, json: async () => [], text: async () => '', headers: new Map() };
      if (u.includes('/v2/call')) {
        const targetId = new URL(u).searchParams.get('target_id');
        if (targetId === '1111') {
          return { ok: false, status: 500, text: async () => 'dialpad down', headers: new Map(), json: async () => ({}) };
        }
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({
            items: [{
              call_id: 'c-2222-1',
              target: { id: '2222' },
              contact: { id: 'shared_contact_pool_Company:X_uid_RF99' },
              date_started: 1717248000000,
              total_duration: 60_000,
              direction: 'outbound',
            }],
            cursor: null,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);

    // Consultant 1's call fetch failed; consultant 2's call still landed.
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id FROM calls').all();
    expect(results).toEqual([{ call_id: 'c-2222-1' }]);
  });
});
