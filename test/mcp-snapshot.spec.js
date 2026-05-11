import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { getSnapshot, resetSnapshot } from '../src/mcp/snapshot.js';

beforeEach(async () => {
  await applyMigration(env);
  resetSnapshot();
});

async function insertCandidate(id, name, added_time_ms = Date.now()) {
  await env.RF_MCP_CACHE
    .prepare(
      'INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms)'
      + ' VALUES (?, ?, ?, ?, ?)'
    )
    .bind(id, name, null, added_time_ms, Date.now())
    .run();
}

async function setSyncStateVersion(value) {
  await env.RF_MCP_CACHE
    .prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_candidates_added_cursor', ?)"
      + " ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind(value)
    .run();
}

describe('mcp-snapshot', () => {
  it('loads rows on first call', async () => {
    const addedMs = Date.parse('2026-01-01T00:00:00Z');
    await insertCandidate(1, 'Alice Smith', addedMs);
    await setSyncStateVersion('2026-05-07T10:00:00Z');

    const snap = await getSnapshot(env);

    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0].id).toBe(1);
    expect(snap.rows[0].name).toBe('Alice Smith');
    expect(snap.rows[0].added_time_ms).toBe(addedMs);
    expect(snap.rows[0].linkedin_profile).toBeNull();
    expect(snap.rows[0].prepared).toBeDefined();
    expect(snap.dataVersion).toBe('2026-05-07T10:00:00Z');
  });

  it('reuses snapshot when version matches', async () => {
    await insertCandidate(1, 'Bob Jones');
    await setSyncStateVersion('v1');

    const snap1 = await getSnapshot(env);
    const snap2 = await getSnapshot(env);

    expect(snap2).toBe(snap1);
  });

  it('reloads when sync_state version advances', async () => {
    await insertCandidate(1, 'Carol White');
    await setSyncStateVersion('v1');

    const snap1 = await getSnapshot(env);

    await setSyncStateVersion('v2');
    await insertCandidate(2, 'Dave Green');

    const snap2 = await getSnapshot(env);

    expect(snap2).not.toBe(snap1);
    expect(snap2.rows).toHaveLength(2);
    expect(snap2.dataVersion).toBe('v2');
  });

  it('falls back to last_tail_sync_at when new cursor absent', async () => {
    await insertCandidate(1, 'Eve Black');
    await env.RF_MCP_CACHE
      .prepare(
        "INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)"
        + " ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind('legacy-version')
      .run();

    const snap = await getSnapshot(env);

    expect(snap.rows).toHaveLength(1);
    expect(snap.dataVersion).toBe('legacy-version');
  });
});
