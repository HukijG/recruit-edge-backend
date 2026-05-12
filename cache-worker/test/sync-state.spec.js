import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/migrate.js';
import { readSyncState, writeSyncState, deleteSyncState } from '../src/sync-state.js';

describe('sync_state helpers', () => {
  beforeEach(async () => {
    await applyMigration(env.RF_MCP_CACHE);
  });

  it('write then read returns the value', async () => {
    await writeSyncState(env, 'test-key', 'test-value');
    const result = await readSyncState(env, 'test-key');
    expect(result).toBe('test-value');
  });

  it('read of missing key returns null', async () => {
    const result = await readSyncState(env, 'no-such-key');
    expect(result).toBeNull();
  });

  it('delete removes the row', async () => {
    await writeSyncState(env, 'to-delete', 'some-value');
    await deleteSyncState(env, 'to-delete');
    const result = await readSyncState(env, 'to-delete');
    expect(result).toBeNull();
  });

  it('write replaces existing value (upsert)', async () => {
    await writeSyncState(env, 'upsert-key', 'first');
    await writeSyncState(env, 'upsert-key', 'second');
    const result = await readSyncState(env, 'upsert-key');
    expect(result).toBe('second');
  });
});
