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
import { runFullRebuild } from '../src/workflow.js';
import * as rfClient from '../src/rf-list-client.js';
import * as snapshots from '../src/snapshots.js';
import { readSyncState, writeSyncState } from '../src/sync-state.js';

const stepShim = {
  do: async (_name, optsOrFn, maybeFn) => {
    const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
    return fn();
  },
};

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
  // Stub snapshot rebuild — exercising it would require open jobs in D1
  // and isn't what these tests are verifying.
  vi.spyOn(snapshots, 'rebuildMcpSnapshots').mockResolvedValue(undefined);
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
