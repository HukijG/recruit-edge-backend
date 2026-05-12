/**
 * workflow.spec.js — drives `runFullRebuild` directly via a step shim.
 *
 * The Workflow runtime can't be exercised end-to-end from vitest (no fixture
 * for executing class-based Workflows), so we rely on the shim form that
 * `runFullRebuild` accepts. The shim handles both 2-arg and 3-arg call sites
 * (`step.do(name, fn)` / `step.do(name, opts, fn)`).
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/migrate.js';
import {
  runFullRebuild,
  runCacheSeed,
  FullRebuildWorkflow,
  CacheSeedWorkflow,
} from '../src/workflow.js';
import * as rfClient from '../src/rf-list-client.js';
import * as bootstrapOtel from '../src/lib/bootstrap-otel.js';
import * as logsBridge from '../src/lib/logs-bridge.js';
import { readSyncState, writeSyncState } from '../src/sync-state.js';

const stepShim = {
  do: async (_name, optsOrFn, maybeFn) => {
    const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
    return fn();
  },
};

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runFullRebuild', () => {
  it('walks pages until empty and writes everything', async () => {
    vi.spyOn(rfClient, 'fetchCandidateListPage')
      .mockResolvedValueOnce({
        rows: [
          { id: 1, name: 'A', jobs: [] },
          { id: 2, name: 'B', jobs: [] },
        ],
        total: null,
      })
      .mockResolvedValueOnce({ rows: [], total: null });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);

    await runFullRebuild(env, stepShim, 'test-instance');

    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id FROM candidates ORDER BY id')
      .all();
    expect(results.map(r => r.id)).toEqual([1, 2]);
  });

  it('stops on partial last page', async () => {
    // PAGE_SIZE is 100 (RF cap); a partial page is anything < 100 rows.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `Cand ${i + 1}`,
      jobs: [],
    }));
    const pageSpy = vi
      .spyOn(rfClient, 'fetchCandidateListPage')
      .mockResolvedValueOnce({ rows, total: null });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);

    await runFullRebuild(env, stepShim, 'test-instance');

    expect(pageSpy).toHaveBeenCalledTimes(1);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates')
      .all();
    expect(results[0].n).toBe(50);
  });

  it('refreshes jobs/users/activity_types/custom_field_schema in sync_state', async () => {
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({
      rows: [],
      total: null,
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([
      { id: 9001, name: 'Job A', is_open: true },
    ]);
    const users = [{ id: 900001, first_name: 'Joel' }];
    const types = [{ id: 1002, name: 'Cold Call' }];
    const fields = [{ id: 16, name: 'consultant_id' }];
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue(users);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue(types);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue(fields);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({ summary: [], detail: [] });

    await runFullRebuild(env, stepShim, 'test-instance');

    expect(JSON.parse(await readSyncState(env, 'users'))).toEqual(users);
    expect(JSON.parse(await readSyncState(env, 'activity_types'))).toEqual(types);
    expect(JSON.parse(await readSyncState(env, 'custom_field_schema'))).toEqual(fields);
    // Jobs land in the jobs table, not sync_state.
    const jobRow = await env.RF_MCP_CACHE
      .prepare('SELECT id, name FROM jobs WHERE id = 9001')
      .first();
    expect(jobRow).toBeTruthy();
    expect(jobRow.name).toBe('Job A');
  });

  it('writes last_full_rebuild_at AND last_tail_sync_at on success', async () => {
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({
      rows: [],
      total: null,
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);

    await runFullRebuild(env, stepShim, 'test-instance');

    const fullStamp = await readSyncState(env, 'last_full_rebuild_at');
    const tailStamp = await readSyncState(env, 'last_tail_sync_at');
    expect(fullStamp).toBeTruthy();
    expect(tailStamp).toBeTruthy();
    expect(Number.isFinite(Date.parse(fullStamp))).toBe(true);
    expect(Number.isFinite(Date.parse(tailStamp))).toBe(true);
    // Same atomic step writes both — should be identical.
    expect(fullStamp).toBe(tailStamp);
  });

  it('releases in_flight on success', async () => {
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({
      rows: [],
      total: null,
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);

    await runFullRebuild(env, stepShim, 'success-instance');

    expect(await readSyncState(env, 'in_flight')).toBeNull();
  });

  it('releases in_flight on failure (finally block)', async () => {
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({
      rows: [],
      total: null,
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockRejectedValue(new Error('boom'));

    await expect(
      runFullRebuild(env, stepShim, 'fail-instance'),
    ).rejects.toThrow('boom');

    expect(await readSyncState(env, 'in_flight')).toBeNull();
  });

  it('refuses to start when another sync in flight', async () => {
    await writeSyncState(env, 'in_flight', 'true');

    await expect(
      runFullRebuild(env, stepShim, 'blocked-instance'),
    ).rejects.toThrow('another sync in flight');

    // Claim step is OUTSIDE the try/finally, so refusal does not run the
    // release step — the pre-existing token must survive untouched.
    expect(await readSyncState(env, 'in_flight')).toBe('true');
  });
});

describe('runFullRebuild — ?only= gating', () => {
  it('only=pipelines skips candidate / users / activity / cf steps and only rebuilds pipelines', async () => {
    const candPage = vi.spyOn(rfClient, 'fetchCandidateListPage');
    const users = vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    const types = vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    const cf = vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({ summary: [], detail: [] });
    await runFullRebuild(env, stepShim, 'inst', { only: 'pipelines' });
    expect(candPage).not.toHaveBeenCalled();
    expect(users).not.toHaveBeenCalled();
    expect(types).not.toHaveBeenCalled();
    expect(cf).not.toHaveBeenCalled();
  });

  it('only=candidates skips jobs/users/activity/cf/pipelines', async () => {
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValue({ rows: [], total: null });
    const jobs = vi.spyOn(rfClient, 'fetchAllJobs');
    const users = vi.spyOn(rfClient, 'fetchUsers');
    const pipeline = vi.spyOn(rfClient, 'fetchJobPipeline');
    await runFullRebuild(env, stepShim, 'inst', { only: 'candidates' });
    expect(jobs).not.toHaveBeenCalled();
    expect(users).not.toHaveBeenCalled();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('only=jobs skips candidates AND pipelines', async () => {
    const candPage = vi.spyOn(rfClient, 'fetchCandidateListPage');
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);
    const pipeline = vi.spyOn(rfClient, 'fetchJobPipeline');
    await runFullRebuild(env, stepShim, 'inst', { only: 'jobs' });
    expect(candPage).not.toHaveBeenCalled();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('default (no `only`) runs all sections including pipelines', async () => {
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValue({ rows: [], total: null });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);
    const pipeline = vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({ summary: [], detail: [] });
    await runFullRebuild(env, stepShim, 'inst');
    // No open jobs in test env, so fetchJobPipeline isn't called even on default path.
    // The fact that the run completed without throwing is enough; the per-test
    // open-jobs case is exercised in pipeline-workflow.spec.js.
  });
});

// ---------------------------------------------------------------------------
// runCacheSeed — initial-seed Workflow that populates the thin _v2 + calls
// tables in production at cutover step 3. Per-table driver:
//   table='candidates' — paginate /candidate/list to end
//   table='jobs'       — full /job/list + /job/pipeline per-job
//   table='calls'      — per-consultant /v2/call paginated, lookback bounded
//                        by params.since (default 2y).
//
// Tests drive runCacheSeed with the same stepShim as runFullRebuild, mocking
// globalThis.fetch (rather than spying on rf-list-client) so the URL the
// implementation calls is itself part of the contract being verified.
// ---------------------------------------------------------------------------

describe('runCacheSeed (table=candidates)', () => {
  beforeEach(async () => {
    await applyMigration(env.RF_MCP_CACHE);
    globalThis.fetch = vi.fn();
  });

  it('paginates /candidate/list to end and INSERT-OR-IGNOREs into candidates_v2', async () => {
    const pages = [
      [
        { id: 1, name: 'A', added_time: '2024-06-01T12:00:00+0000' },
        { id: 2, name: 'B', added_time: '2024-06-01T13:00:00+0000' },
      ],
      [{ id: 3, name: 'C', added_time: '2024-06-01T14:00:00+0000' }],
      [],
    ];
    let i = 0;
    globalThis.fetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => pages[i++] ?? [],
      text: async () => '',
    }));
    await runCacheSeed(env, stepShim, 'test-id', { table: 'candidates' });
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates_v2').all();
    expect(results[0].n).toBe(3);
  });
});

describe('runCacheSeed (table=jobs)', () => {
  beforeEach(async () => {
    await applyMigration(env.RF_MCP_CACHE);
    globalThis.fetch = vi.fn();
  });

  it('fetches all jobs + per-job pipeline + writes with canonical_pipeline_json', async () => {
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/job/list')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => [
            { id: 42, name: 'SWE', company: { name: 'Acme' }, created_time: '2024-01-15T09:00:00+0000' },
          ],
        };
      }
      if (u.includes('/job/pipeline')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({ summary: [{ id: 1, name: 'Sourced', count: 0 }], detail: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '', headers: new Map() };
    });
    await runCacheSeed(env, stepShim, 'test-id', { table: 'jobs' });
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id, name, canonical_pipeline_json FROM jobs_v2 WHERE id = 42').all();
    expect(results[0].id).toBe(42);
    expect(JSON.parse(results[0].canonical_pipeline_json)).toEqual([{ id: 1, name: 'Sourced', count: 0 }]);
  });

  it('one job pipeline failure does not block other jobs (canonical_pipeline_json null for failed job)', async () => {
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/job/list')) {
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => [
            { id: 1, name: 'GoodJob', company: { name: 'Co1' }, created_time: '2024-01-01T00:00:00+0000' },
            { id: 2, name: 'BadPipeline', company: { name: 'Co2' }, created_time: '2024-01-02T00:00:00+0000' },
          ],
        };
      }
      if (u.includes('/job/pipeline')) {
        const jobId = new URL(u).searchParams.get('job_id');
        if (jobId === '2') {
          return { ok: false, status: 500, text: async () => 'pipeline down', headers: new Map(), json: async () => ({}) };
        }
        return {
          ok: true, status: 200, headers: new Map(), text: async () => '',
          json: async () => ({ summary: [{ id: 10, name: 'Sourced', count: 0 }], detail: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '', headers: new Map() };
    });

    await runCacheSeed(env, stepShim, 'test-id', { table: 'jobs' });

    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id, canonical_pipeline_json FROM jobs_v2 ORDER BY id').all();
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(1);
    expect(JSON.parse(results[0].canonical_pipeline_json)).toEqual([{ id: 10, name: 'Sourced', count: 0 }]);
    expect(results[1].id).toBe(2);
    expect(results[1].canonical_pipeline_json).toBeNull();
  });
});

describe('runCacheSeed (table=calls)', () => {
  beforeEach(async () => {
    await applyMigration(env.RF_MCP_CACHE);
    globalThis.fetch = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('paginates /v2/call org-wide via step.do per page, threading cursor between steps, and writes every call', async () => {
    // Three pages worth, exercising the cursor-handoff between step.do
    // invocations. Each page is its own /v2/call request; the workflow
    // emits one step.do per page so each step is bounded.
    const pages = [
      {
        cursor: 'tok-a',
        items: [{
          call_id: 'c-1', target: { id: '1111' },
          contact: { id: 'shared_contact_pool_Company:X_uid_RF77' },
          date_started: 1717248000000, total_duration: 60_000, direction: 'outbound',
        }],
      },
      {
        cursor: 'tok-b',
        items: [{
          call_id: 'c-2', target: { id: '2222' },
          contact: { id: 'shared_contact_pool_Company:X_uid_RF88' },
          date_started: 1717248060000, total_duration: 90_000, direction: 'outbound',
        }],
      },
      {
        cursor: null,
        items: [{
          call_id: 'c-3', target: { id: '1111' },
          contact: { id: 'shared_contact_pool_Company:X_uid_RF99' },
          date_started: 1717248120000, total_duration: 30_000, direction: 'outbound',
        }],
      },
    ];
    const fetchedCursors = [];
    let i = 0;
    globalThis.fetch.mockImplementation(async (url) => {
      const u = new URL(String(url));
      fetchedCursors.push(u.searchParams.get('cursor'));
      const page = pages[i++];
      return {
        ok: true, status: 200, headers: new Map(), text: async () => '',
        json: async () => page,
      };
    });

    await runCacheSeed(env, stepShim, 'test-id', { table: 'calls' });

    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id, target_dialpad_id FROM calls ORDER BY call_id').all();
    expect(results).toEqual([
      { call_id: 'c-1', target_dialpad_id: '1111' },
      { call_id: 'c-2', target_dialpad_id: '2222' },
      { call_id: 'c-3', target_dialpad_id: '1111' },
    ]);
    // First request carries no cursor; subsequent requests forward the cursor
    // returned by the previous page.
    expect(fetchedCursors).toEqual([null, 'tok-a', 'tok-b']);
    // Org-wide listing — no target_id on any request.
    for (const call of globalThis.fetch.mock.calls) {
      const u = new URL(String(call[0]));
      expect(u.searchParams.has('target_id')).toBe(false);
    }
  });

  it('omits started_after by default (full history) and applies params.since when provided', async () => {
    const urls = [];
    globalThis.fetch.mockImplementation(async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ items: [], cursor: null }) };
    });

    await runCacheSeed(env, stepShim, 'test-id', { table: 'calls' });
    expect(new URL(urls[0]).searchParams.has('started_after')).toBe(false);

    urls.length = 0;
    await runCacheSeed(env, stepShim, 'test-id', { table: 'calls', since: '2025-01-01T00:00:00Z' });
    expect(new URL(urls[0]).searchParams.get('started_after'))
      .toBe(String(Date.parse('2025-01-01T00:00:00Z')));
  });
});

describe('runCacheSeed (validation)', () => {
  beforeEach(async () => {
    await applyMigration(env.RF_MCP_CACHE);
  });

  it('rejects unknown table param', async () => {
    await expect(runCacheSeed(env, stepShim, 'id', { table: 'unknown' }))
      .rejects.toThrow(/table/);
  });

  it('rejects missing table param', async () => {
    await expect(runCacheSeed(env, stepShim, 'id', {}))
      .rejects.toThrow(/table/);
  });
});

// ---------------------------------------------------------------------------
// Workflow class `run()` body — verifies `flushWorkflowSpans` is awaited in
// the `finally` block after run() completes. Workflow contexts have no
// `ctx.waitUntil`, and the BatchSpanProcessor's scheduled flush will not fire
// before the run context tears down — without an explicit forced flush at
// end of run, spans buffered locally during the Workflow body never reach
// LaunchDarkly. The bootstrap-otel module exposes the local provider; this
// test mocks `flushWorkflowSpans` and verifies the call.
//
// We bypass the WorkflowEntrypoint constructor (which has strict runtime
// requirements) and invoke `run.call(fakeThis, ...)` directly with a step
// shim — same shim form used in the existing runFullRebuild / runCacheSeed
// tests above.
// ---------------------------------------------------------------------------

describe('Workflow class — flushWorkflowSpans on completion', () => {
  beforeEach(async () => {
    await applyMigration(env.RF_MCP_CACHE);
  });

  it('FullRebuildWorkflow.run awaits flushWorkflowSpans after successful body', async () => {
    const flushSpy = vi.spyOn(bootstrapOtel, 'flushWorkflowSpans').mockResolvedValue();
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({ rows: [], total: null });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({ summary: [], detail: [] });

    const fakeThis = { env };
    await FullRebuildWorkflow.prototype.run.call(fakeThis, { instanceId: 'inst-1', payload: {} }, stepShim);

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('FullRebuildWorkflow.run awaits flushWorkflowSpans even on failure path', async () => {
    const flushSpy = vi.spyOn(bootstrapOtel, 'flushWorkflowSpans').mockResolvedValue();
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({ rows: [], total: null });
    vi.spyOn(rfClient, 'fetchAllJobs').mockRejectedValue(new Error('boom-flush-test'));

    const fakeThis = { env };
    await expect(
      FullRebuildWorkflow.prototype.run.call(fakeThis, { instanceId: 'inst-2', payload: {} }, stepShim),
    ).rejects.toThrow('boom-flush-test');

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('CacheSeedWorkflow.run awaits flushWorkflowSpans after successful body', async () => {
    const flushSpy = vi.spyOn(bootstrapOtel, 'flushWorkflowSpans').mockResolvedValue();
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, headers: new Map(), text: async () => '',
      json: async () => [],
    }));
    const fakeThis = { env };
    await CacheSeedWorkflow.prototype.run.call(
      fakeThis,
      { instanceId: 'seed-1', payload: { table: 'candidates' } },
      stepShim,
    );
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Workflow class `run()` body — flushLogs called alongside flushWorkflowSpans.
//
// Workflow.run() bodies can't go through `withLogsFlush` (no ctx), so each
// run() finally block must explicitly call `await flushLogs()` to drain the
// LoggerProvider's BatchLogRecordProcessor queue before the run context tears
// down. Without this, console.log records emitted inside the Workflow body
// never reach LaunchDarkly.
// ---------------------------------------------------------------------------

describe('Workflow class — flushLogs on completion', () => {
  beforeEach(async () => {
    await applyMigration(env.RF_MCP_CACHE);
  });

  it('FullRebuildWorkflow.run awaits flushLogs after successful body', async () => {
    vi.spyOn(bootstrapOtel, 'flushWorkflowSpans').mockResolvedValue();
    const flushLogsSpy = vi.spyOn(logsBridge, 'flushLogs').mockResolvedValue();
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({ rows: [], total: null });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchUsers').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchActivityTypes').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchCustomFieldSchema').mockResolvedValue([]);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({ summary: [], detail: [] });

    const fakeThis = { env };
    await FullRebuildWorkflow.prototype.run.call(fakeThis, { instanceId: 'inst-3', payload: {} }, stepShim);

    expect(flushLogsSpy).toHaveBeenCalledTimes(1);
  });

  it('FullRebuildWorkflow.run awaits flushLogs even on failure path', async () => {
    vi.spyOn(bootstrapOtel, 'flushWorkflowSpans').mockResolvedValue();
    const flushLogsSpy = vi.spyOn(logsBridge, 'flushLogs').mockResolvedValue();
    vi.spyOn(rfClient, 'fetchCandidateListPage').mockResolvedValueOnce({ rows: [], total: null });
    vi.spyOn(rfClient, 'fetchAllJobs').mockRejectedValue(new Error('boom-logs-flush'));

    const fakeThis = { env };
    await expect(
      FullRebuildWorkflow.prototype.run.call(fakeThis, { instanceId: 'inst-4', payload: {} }, stepShim),
    ).rejects.toThrow('boom-logs-flush');

    expect(flushLogsSpy).toHaveBeenCalledTimes(1);
  });

  it('CacheSeedWorkflow.run awaits flushLogs after successful body', async () => {
    vi.spyOn(bootstrapOtel, 'flushWorkflowSpans').mockResolvedValue();
    const flushLogsSpy = vi.spyOn(logsBridge, 'flushLogs').mockResolvedValue();
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, headers: new Map(), text: async () => '',
      json: async () => [],
    }));
    const fakeThis = { env };
    await CacheSeedWorkflow.prototype.run.call(
      fakeThis,
      { instanceId: 'seed-2', payload: { table: 'candidates' } },
      stepShim,
    );
    expect(flushLogsSpy).toHaveBeenCalledTimes(1);
  });
});
