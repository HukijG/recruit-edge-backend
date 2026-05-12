import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker, { tailSync, tailSyncThin } from '../src/index.js';
import * as rfClient from '../src/rf-list-client.js';
import { readSyncState, writeSyncState } from '../src/sync-state.js';
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

afterEach(() => {
  vi.restoreAllMocks();
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

  it('makes one org-wide /v2/call fetch (no per-consultant fan-out) and writes every call', async () => {
    let callsCallCount = 0;
    let lastCallsUrl = null;
    mockJSON(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '', headers: new Map() };
      if (u.includes('/job/list')) return { ok: true, status: 200, json: async () => [], text: async () => '', headers: new Map() };
      if (u.includes('/v2/call')) {
        callsCallCount++;
        lastCallsUrl = u;
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({
            items: [
              {
                call_id: 'c-1111-1',
                target: { id: '1111' },
                contact: { id: 'shared_contact_pool_Company:X_uid_RF99' },
                date_started: 1717248000000,
                total_duration: 60_000,
                direction: 'outbound',
              },
              {
                call_id: 'c-2222-1',
                target: { id: '2222' },
                contact: { id: 'shared_contact_pool_Company:X_uid_RF99' },
                date_started: 1717248060000,
                total_duration: 60_000,
                direction: 'outbound',
              },
            ],
            cursor: null,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', headers: new Map() };
    });

    await tailSyncThin(env);

    expect(callsCallCount).toBe(1);
    // Org-wide fetch — no target_id filter, attribution comes from item.target.id.
    expect(new URL(lastCallsUrl).searchParams.has('target_id')).toBe(false);
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

});

describe('getCacheCronAdditiveFlag gate in scheduled()', () => {
  // Helper: run the scheduled handler and wait for its ctx.waitUntil promise.
  async function runScheduled(testEnv) {
    let waitUntilPromise;
    const ctx = { waitUntil: (p) => { waitUntilPromise = p; } };
    await worker.scheduled({}, testEnv, ctx);
    await waitUntilPromise;
  }

  beforeEach(async () => {
    // Stub legacy tailSync so it doesn't hit RF API.
    vi.spyOn(rfClient, 'fetchCandidatesUpdatedSince').mockResolvedValue({
      ids: [],
      suggestedCursor: '2026-01-01T00:00:00.000Z',
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    // Stub the fetch used inside tailSyncThin subtasks.
    globalThis.fetch = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({ data: [{ id: 777, name: 'FlagTest', added_time: '2026-01-01T01:00:00+0000' }] }),
        };
      }
      if (u.includes('/job/list')) {
        return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      }
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });
  });

  it('does NOT write thin tables when CRON_THIN_ENABLED is unset (flag off)', async () => {
    // env from cloudflare:test does not have CRON_THIN_ENABLED set.
    await runScheduled(env);

    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id FROM candidates_v2').all();
    expect(results).toEqual([]); // tailSyncThin was not called; no thin rows written
  });

  it('writes thin tables when CRON_THIN_ENABLED="true" (flag on)', async () => {
    const testEnv = { ...env, CRON_THIN_ENABLED: 'true' };
    await runScheduled(testEnv);

    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id FROM candidates_v2').all();
    expect(results).toEqual([{ id: 777 }]); // tailSyncThin ran; thin row landed
  });
});

describe('CRON_LEGACY_ENABLED gate in scheduled()', () => {
  // Background (project memory `project_sync_cron_disabled.md`): the legacy
  // writers don't skip unchanged rows; they REPLACE every job/candidate every
  // tick, driving a ~1M D1 writes/day storm. Until cutover step 6 deletes
  // the legacy code entirely, the legacy path MUST stay inert at runtime.
  async function runScheduled(testEnv) {
    let waitUntilPromise;
    const ctx = { waitUntil: (p) => { waitUntilPromise = p; } };
    await worker.scheduled({}, testEnv, ctx);
    await waitUntilPromise;
  }

  let fetchCandidatesUpdatedSpy;
  beforeEach(() => {
    fetchCandidatesUpdatedSpy = vi
      .spyOn(rfClient, 'fetchCandidatesUpdatedSince')
      .mockResolvedValue({ ids: [], suggestedCursor: '2026-01-01T00:00:00.000Z' });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true, status: 200, headers: new Map(), text: async () => '',
      json: async () => ({ data: [], items: [], cursor: null }),
    }));
  });

  it('does NOT call legacy tailSync when CRON_LEGACY_ENABLED is unset (default OFF)', async () => {
    await runScheduled(env);
    // Legacy tailSync's hot path begins with /candidate/search-style fetch via
    // fetchCandidatesUpdatedSince. If it wasn't called, the gate worked.
    expect(fetchCandidatesUpdatedSpy).not.toHaveBeenCalled();
  });

  it('does NOT call legacy tailSync when CRON_LEGACY_ENABLED="false"', async () => {
    const testEnv = { ...env, CRON_LEGACY_ENABLED: 'false' };
    await runScheduled(testEnv);
    expect(fetchCandidatesUpdatedSpy).not.toHaveBeenCalled();
  });

  it('DOES call legacy tailSync when CRON_LEGACY_ENABLED="true"', async () => {
    const testEnv = { ...env, CRON_LEGACY_ENABLED: 'true' };
    await runScheduled(testEnv);
    expect(fetchCandidatesUpdatedSpy).toHaveBeenCalledTimes(1);
  });

  it('also accepts CRON_LEGACY_ENABLED="1" as truthy', async () => {
    const testEnv = { ...env, CRON_LEGACY_ENABLED: '1' };
    await runScheduled(testEnv);
    expect(fetchCandidatesUpdatedSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT spawn PIPELINE_REBUILD_WORKFLOW from scheduled()', async () => {
    // Dead infrastructure: the workflow class is kept exported so existing
    // queued instances still resolve their class registration, but no new
    // instances must be created from cron.
    const create = vi.fn().mockResolvedValue({ id: 'wf-test' });
    const testEnv = { ...env, PIPELINE_REBUILD_WORKFLOW: { create } };
    await runScheduled(testEnv);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('per-subtask in-flight watchdog (tailSyncThin)', () => {
  // Each thin subtask runs under its own in-flight lease so a stuck or
  // long-running tick can't dogpile the next cron tick. Watchdog forcibly
  // clears the lease after 6h.
  function mockEmptyAPI() {
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ data: [] }) };
      }
      if (u.includes('/job/list')) {
        return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      }
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });
  }

  it('candidates subtask claims and releases its own lease on a successful run', async () => {
    mockEmptyAPI();
    expect(await readSyncState(env, 'thin_candidates_in_flight')).toBeNull();
    await tailSyncThin(env);
    // Lease released in finally — should NOT remain set after a clean tick.
    expect(await readSyncState(env, 'thin_candidates_in_flight')).toBeNull();
    // Successful-completion marker written.
    expect(await readSyncState(env, 'thin_candidates_done_at')).toBeTruthy();
  });

  it('jobs subtask claims and releases its own lease on a successful run', async () => {
    mockEmptyAPI();
    await tailSyncThin(env);
    expect(await readSyncState(env, 'thin_jobs_in_flight')).toBeNull();
    expect(await readSyncState(env, 'thin_jobs_done_at')).toBeTruthy();
  });

  it('calls subtask claims and releases its own lease on a successful run', async () => {
    mockEmptyAPI();
    await tailSyncThin(env);
    expect(await readSyncState(env, 'thin_calls_in_flight')).toBeNull();
    expect(await readSyncState(env, 'thin_calls_done_at')).toBeTruthy();
  });

  it('skips candidates subtask when its lease is held (and lease is younger than watchdog)', async () => {
    // Seed a freshly-claimed lease.
    await writeSyncState(env, 'thin_candidates_in_flight', new Date().toISOString());
    // Spy on the candidate fetch — it must NOT be invoked when the lease is held.
    const candidateSearchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Map(), text: async () => '',
      json: async () => ({ data: [{ id: 999, name: 'SHOULD NOT WRITE', added_time: '2024-06-01T12:00:00+0000' }] }),
    });
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) return candidateSearchSpy(url);
      if (u.includes('/job/list')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });

    await tailSyncThin(env);

    expect(candidateSearchSpy).not.toHaveBeenCalled();
    // Nothing landed in candidates_v2 because the subtask was skipped.
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates_v2').all();
    expect(results[0].n).toBe(0);
    // The lease should still be held (the watchdog hasn't fired).
    expect(await readSyncState(env, 'thin_candidates_in_flight')).toBeTruthy();
  });

  it('watchdog clears a >6h stale candidates lease and allows the subtask to run', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString();
    await writeSyncState(env, 'thin_candidates_in_flight', sevenHoursAgo);
    // Need an old cursor too so the candidates row is accepted.
    await writeSyncState(env, 'last_candidates_added_cursor', '2024-01-01T00:00:00.000Z');

    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({ data: [{ id: 8000, name: 'WatchdogRecovery', added_time: '2024-06-01T12:00:00+0000' }] }),
        };
      }
      if (u.includes('/job/list')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });

    await tailSyncThin(env);

    // Watchdog cleared the stale lease, then the subtask claimed/released it.
    expect(await readSyncState(env, 'thin_candidates_in_flight')).toBeNull();
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id FROM candidates_v2').all();
    expect(results).toEqual([{ id: 8000 }]);
  });

  it('watchdog clears a >6h stale jobs lease and allows the subtask to run', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString();
    await writeSyncState(env, 'thin_jobs_in_flight', sevenHoursAgo);
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ data: [] }) };
      if (u.includes('/job/list')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => [{ id: 800, name: 'WatchdogJob', company: { name: 'X' }, created_time: '2024-01-15T09:00:00+0000' }],
        };
      }
      if (u.includes('/job/pipeline')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ summary: [], detail: [] }) };
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });

    await tailSyncThin(env);

    expect(await readSyncState(env, 'thin_jobs_in_flight')).toBeNull();
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id FROM jobs_v2').all();
    expect(results).toEqual([{ id: 800 }]);
  });

  it('watchdog clears a >6h stale calls lease and allows the subtask to run', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString();
    await writeSyncState(env, 'thin_calls_in_flight', sevenHoursAgo);
    await env.USERS_DB.prepare(
      `INSERT INTO users (email, rf_user_id, dialpad_id, first_name) VALUES (?, ?, ?, ?)`
    ).bind('a@test.local', 1, '1111', 'A').run();

    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ data: [] }) };
      if (u.includes('/job/list')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      if (u.includes('/v2/call')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({
            items: [{
              call_id: 'c-watchdog-1',
              target: { id: '1111' },
              contact: { id: 'shared_contact_pool_Company:X_uid_RF99' },
              date_started: 1717248000000, total_duration: 60_000, direction: 'outbound',
            }],
            cursor: null,
          }),
        };
      }
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({}) };
    });

    await tailSyncThin(env);

    expect(await readSyncState(env, 'thin_calls_in_flight')).toBeNull();
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id FROM calls').all();
    expect(results).toEqual([{ call_id: 'c-watchdog-1' }]);
  });

  it('lease is released even when a subtask body throws mid-run', async () => {
    // Trigger an unexpected throw inside the candidates subtask by making
    // the RF /candidate/search call return a malformed payload that crashes
    // fetchCandidatesAddedSince. The structured-catch inside the subtask
    // should swallow it but the finally still releases the lease.
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) {
        return { ok: false, status: 500, headers: new Map(), text: async () => 'rf down', json: async () => ({}) };
      }
      if (u.includes('/job/list')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });

    await tailSyncThin(env);

    expect(await readSyncState(env, 'thin_candidates_in_flight')).toBeNull();
  });
});

describe('cron cold-start cursor defaults (2-year lookback)', () => {
  // Cold start (no cursor in sync_state) must mirror the seed default. The
  // legacy 1-day fallback meant a fresh deployment without a prior admin seed
  // silently lost everything older than 1 day.
  it('candidates subtask uses a ~2-year-old cursor when sync_state has none', async () => {
    let observedDate = null;
    globalThis.fetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/candidate/search') && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        const filter = (body.filters ?? []).find(f => f.key === 'added_on');
        if (filter) observedDate = filter.date;
        return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ data: [] }) };
      }
      if (u.includes('/job/list')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });

    // Sanity: sync_state has no cursor row for last_candidates_added_cursor.
    expect(await readSyncState(env, 'last_candidates_added_cursor')).toBeNull();
    await tailSyncThin(env);

    expect(observedDate).toBeTruthy();
    const ageDays = (Date.now() - Date.parse(observedDate + 'T00:00:00Z')) / 86400_000;
    // 2y ≈ 730 days. Allow ±10 days slack (leap years + day-granularity of
    // RF's date filter rounding to YYYY-MM-DD).
    expect(ageDays).toBeGreaterThan(720);
    expect(ageDays).toBeLessThan(750);
  });

  it('calls subtask uses a ~2-year-old started_after when no prior call rows exist for a consultant', async () => {
    // Seed a consultant but NO calls rows — exercises the fallback.
    await env.USERS_DB.prepare(
      `INSERT INTO users (email, rf_user_id, dialpad_id, first_name) VALUES (?, ?, ?, ?)`
    ).bind('a@test.local', 1, '1111', 'A').run();

    let observedStartedAfter = null;
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/candidate/search')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ data: [] }) };
      if (u.includes('/job/list')) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => [] };
      if (u.includes('/v2/call')) {
        observedStartedAfter = Number(new URL(u).searchParams.get('started_after'));
        return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
      }
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({}) };
    });

    await tailSyncThin(env);

    expect(observedStartedAfter).toBeTruthy();
    const ageMs = Date.now() - observedStartedAfter;
    // 2y ≈ 63072000000ms minus the 6h overlap window (≈21600000ms). Allow
    // ±1 day slack to absorb time-drift over a test run.
    const twoYearsMs = 2 * 365 * 24 * 3600 * 1000;
    expect(ageMs).toBeGreaterThan(twoYearsMs - 24 * 3600_000);
    expect(ageMs).toBeLessThan(twoYearsMs + 24 * 3600_000);
  });
});
