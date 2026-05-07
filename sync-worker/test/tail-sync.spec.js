import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyMigration } from './helpers/migrate.js';
import { tailSync } from '../src/sync-worker.js';
import * as rfClient from '../src/rf-list-client.js';
import * as snapshots from '../src/snapshots.js';
import { readSyncState, writeSyncState } from '../src/sync-state.js';

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tailSync', () => {
  it('skips when in_flight is set', async () => {
    await writeSyncState(env, 'in_flight', 'true');
    const spy = vi.spyOn(rfClient, 'fetchCandidatesUpdatedSince');
    await tailSync(env);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches updated ids, writes to D1, advances cursor', async () => {
    vi.spyOn(rfClient, 'fetchCandidatesUpdatedSince').mockResolvedValue({
      ids: [42],
      suggestedCursor: '2026-05-07T12:00:00Z',
    });
    vi.spyOn(rfClient, 'fetchCandidate').mockResolvedValue({
      id: 42,
      name: 'Test',
      primary_email: 't@x.com',
      last_updated: '2026-05-07T12:00:00Z',
      jobs: [],
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    // Stub snapshot rebuild — exercising it would require open jobs in D1
    // and isn't what this test is verifying.
    vi.spyOn(snapshots, 'rebuildMcpSnapshots').mockResolvedValue(undefined);

    await tailSync(env);

    const c = await env.RF_MCP_CACHE
      .prepare('SELECT name FROM candidates WHERE id = 42')
      .first();
    expect(c.name).toBe('Test');
    expect(await readSyncState(env, 'last_tail_sync_at')).toBe('2026-05-07T12:00:00Z');
    expect(await readSyncState(env, 'in_flight')).toBeNull();
    expect(await readSyncState(env, 'last_tail_sync_count')).toBe('1');
  });

  it('watchdog clears in_flight after 6h of no advance', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString();
    await writeSyncState(env, 'in_flight', 'true');
    await writeSyncState(env, 'last_tail_sync_at', sevenHoursAgo);

    const fetchSpy = vi
      .spyOn(rfClient, 'fetchCandidatesUpdatedSince')
      .mockResolvedValue({ ids: [], suggestedCursor: '2026-05-07T13:00:00Z' });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);

    await tailSync(env);

    // tail sync proceeded (fetch was called) and in_flight was cleared on exit.
    expect(fetchSpy).toHaveBeenCalled();
    expect(await readSyncState(env, 'in_flight')).toBeNull();
  });

  it('empty ids array does not call rebuildMcpSnapshots', async () => {
    vi.spyOn(rfClient, 'fetchCandidatesUpdatedSince').mockResolvedValue({
      ids: [],
      suggestedCursor: '2026-05-07T14:00:00Z',
    });
    const fetchCandSpy = vi.spyOn(rfClient, 'fetchCandidate');
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    const rebuildSpy = vi
      .spyOn(snapshots, 'rebuildMcpSnapshots')
      .mockResolvedValue(undefined);

    await tailSync(env);

    expect(fetchCandSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    // Cursor still advances on empty, even with no upserts.
    expect(await readSyncState(env, 'last_tail_sync_at')).toBe('2026-05-07T14:00:00Z');
    expect(await readSyncState(env, 'last_tail_sync_count')).toBe('0');
    expect(await readSyncState(env, 'in_flight')).toBeNull();
  });

  it('refreshes jobs every tick (even when no candidate updates)', async () => {
    vi.spyOn(rfClient, 'fetchCandidatesUpdatedSince').mockResolvedValue({
      ids: [],
      suggestedCursor: '2026-05-07T16:00:00Z',
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([
      { id: 7001, name: 'New Job', is_open: true },
    ]);
    vi.spyOn(snapshots, 'rebuildMcpSnapshots').mockResolvedValue(undefined);

    await tailSync(env);

    const row = await env.RF_MCP_CACHE
      .prepare('SELECT id, name FROM jobs WHERE id = 7001')
      .first();
    expect(row).toBeTruthy();
    expect(row.name).toBe('New Job');
  });

  it('failure mid-batch does not advance cursor', async () => {
    await writeSyncState(env, 'last_tail_sync_at', '2026-05-01T00:00:00Z');

    vi.spyOn(rfClient, 'fetchCandidatesUpdatedSince').mockResolvedValue({
      ids: [1, 2],
      suggestedCursor: '2026-05-07T15:00:00Z',
    });
    vi.spyOn(rfClient, 'fetchCandidate').mockImplementation(async (_env, id) => {
      if (id === 2) throw new Error('simulated upstream failure');
      return { id, name: `C${id}`, primary_email: `c${id}@x.com`, jobs: [] };
    });
    vi.spyOn(rfClient, 'fetchAllJobs').mockResolvedValue([]);
    vi.spyOn(snapshots, 'rebuildMcpSnapshots').mockResolvedValue(undefined);

    await tailSync(env);

    // in_flight cleared via finally
    expect(await readSyncState(env, 'in_flight')).toBeNull();
    // cursor not advanced — still at the prior value
    expect(await readSyncState(env, 'last_tail_sync_at')).toBe('2026-05-01T00:00:00Z');
  });
});
