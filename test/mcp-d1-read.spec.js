import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { countTable } from '../src/mcp/d1-read.js';

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
});

describe('d1-read', () => {
  it('countTable counts rows', async () => {
    expect(await countTable(env, 'candidates_v2')).toBe(0);
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (1, 'A', null, 1, 1)`
    ).run();
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (2, 'B', null, 2, 2)`
    ).run();
    expect(await countTable(env, 'candidates_v2')).toBe(2);
  });
});

describe('job_pipelines migration', () => {
  it('creates the table', async () => {
    await applyMigration(env);
    const row = await env.RF_MCP_CACHE
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_pipelines'")
      .first();
    expect(row?.name).toBe('job_pipelines');
  });
});

// ---------------------------------------------------------------------------
// New thin-schema reader helpers (Task 12)
// ---------------------------------------------------------------------------

import {
  getThinCandidateById,
  getCandidatesByIds,
  getCallsForCandidate,
} from '../src/mcp/d1-read.js';

describe('getThinCandidateById', () => {
  it('returns the row when found, including snapshot columns', async () => {
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms,
                                  current_title_at_cache_time, current_company_at_cache_time, cached_at_ms)
       VALUES (1, 'Jane', 'jane-doe', 1, 'Engineer', 'Acme', 1)`
    ).run();
    expect(await getThinCandidateById(env, 1)).toEqual({
      id: 1,
      name: 'Jane',
      linkedin_profile: 'jane-doe',
      added_time_ms: 1,
      current_title_at_cache_time: 'Engineer',
      current_company_at_cache_time: 'Acme',
    });
  });
  it('returns null when not found', async () => {
    expect(await getThinCandidateById(env, 999)).toBeNull();
  });
});

describe('getCandidatesByIds', () => {
  it('returns rows for the given id-list, preserving the input order', async () => {
    await env.RF_MCP_CACHE.batch([
      env.RF_MCP_CACHE.prepare(`INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (1, 'A', null, 1, 1)`),
      env.RF_MCP_CACHE.prepare(`INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (2, 'B', null, 2, 2)`),
      env.RF_MCP_CACHE.prepare(`INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (3, 'C', null, 3, 3)`),
    ]);
    const out = await getCandidatesByIds(env, [3, 1, 2]);
    expect(out.map(r => r.id)).toEqual([3, 1, 2]);
  });
  it('chunks id-lists larger than the SQLite expression limit', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => i + 1);
    const stmts = ids.map(i =>
      env.RF_MCP_CACHE.prepare(
        `INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (?, ?, null, ?, ?)`
      ).bind(i, `c${i}`, i, i)
    );
    for (let i = 0; i < stmts.length; i += 100) {
      await env.RF_MCP_CACHE.batch(stmts.slice(i, i + 100));
    }
    const out = await getCandidatesByIds(env, ids);
    expect(out.length).toBe(1500);
  });
  it('returns empty array on empty input', async () => {
    expect(await getCandidatesByIds(env, [])).toEqual([]);
  });
  it('skips ids not in the cache (no errors)', async () => {
    await env.RF_MCP_CACHE.prepare(
      `INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (5, 'E', null, 5, 5)`
    ).run();
    const out = await getCandidatesByIds(env, [5, 999, 1000]);
    expect(out.map(r => r.id)).toEqual([5]);
  });
  it('dedups duplicate input ids (preserves first-occurrence order)', async () => {
    await env.RF_MCP_CACHE.batch([
      env.RF_MCP_CACHE.prepare(`INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (1, 'A', null, 1, 1)`),
      env.RF_MCP_CACHE.prepare(`INSERT INTO candidates_v2 (id, name, linkedin_profile, added_time_ms, cached_at_ms) VALUES (5, 'E', null, 5, 5)`),
    ]);
    const out = await getCandidatesByIds(env, [5, 5, 1, 5]);
    expect(out.map(r => r.id)).toEqual([5, 1]);
  });
});

describe('getCallsForCandidate', () => {
  beforeEach(async () => {
    await env.RF_MCP_CACHE.batch([
      env.RF_MCP_CACHE.prepare(`INSERT INTO calls (call_id, target_dialpad_id, rf_candidate_id, date_started_ms, duration_ms, direction, cached_at_ms) VALUES ('c1', '5357', 42, 1000, 200000, 'outbound', 1)`),
      env.RF_MCP_CACHE.prepare(`INSERT INTO calls (call_id, target_dialpad_id, rf_candidate_id, date_started_ms, duration_ms, direction, cached_at_ms) VALUES ('c2', '5357', 42, 2000,  60000, 'outbound', 1)`),
      env.RF_MCP_CACHE.prepare(`INSERT INTO calls (call_id, target_dialpad_id, rf_candidate_id, date_started_ms, duration_ms, direction, cached_at_ms) VALUES ('c3', '5357', 42, 3000, 180000, 'inbound',  1)`),
      env.RF_MCP_CACHE.prepare(`INSERT INTO calls (call_id, target_dialpad_id, rf_candidate_id, date_started_ms, duration_ms, direction, cached_at_ms) VALUES ('c4', 'OTHER', 42, 4000, 200000, 'outbound', 1)`),
    ]);
  });
  it('filters by target + candidate, applies min duration, sorts DESC', async () => {
    const rows = await getCallsForCandidate(env, '5357', 42, {
      minDurationMs: 120000,
      startedAfterMs: 0,
      startedBeforeMs: 5000,
      limit: 20,
    });
    expect(rows.map(r => r.call_id)).toEqual(['c3', 'c1']);
  });
  it('respects window bounds', async () => {
    const rows = await getCallsForCandidate(env, '5357', 42, {
      minDurationMs: 0, startedAfterMs: 1500, startedBeforeMs: 2500, limit: 20,
    });
    expect(rows.map(r => r.call_id)).toEqual(['c2']);
  });
  it('does not leak across target_dialpad_id', async () => {
    const rows = await getCallsForCandidate(env, '5357', 42, {
      minDurationMs: 0, startedAfterMs: 0, startedBeforeMs: 99999, limit: 20,
    });
    expect(rows.every(r => r.call_id !== 'c4')).toBe(true);
  });
  it('respects limit', async () => {
    const rows = await getCallsForCandidate(env, '5357', 42, {
      minDurationMs: 0, startedAfterMs: 0, startedBeforeMs: 99999, limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].call_id).toBe('c3'); // most recent
  });
  it('uses default minDurationMs=120000 when not provided', async () => {
    const rows = await getCallsForCandidate(env, '5357', 42, {
      startedAfterMs: 0, startedBeforeMs: 99999, limit: 20,
    });
    // c2 (60000) excluded by default 120000 minimum
    expect(rows.map(r => r.call_id).sort()).toEqual(['c1', 'c3']);
  });
});
