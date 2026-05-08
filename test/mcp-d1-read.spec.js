import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import {
  getCandidateById,
  getCandidateByEmail,
  getCandidateByLinkedIn,
  countTable,
} from '../src/mcp/d1-read.js';

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
});

async function insertCandidate(row) {
  const {
    id,
    body,
    name = null,
    primary_email = null,
    linkedin_profile = null,
    cached_at = new Date().toISOString(),
  } = row;
  await env.RF_MCP_CACHE
    .prepare(
      'INSERT INTO candidates (id, body, name, primary_email, linkedin_profile, cached_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(id, body, name, primary_email, linkedin_profile, cached_at)
    .run();
}

describe('d1-read', () => {
  it('getCandidateById parses body JSON', async () => {
    await insertCandidate({
      id: 42,
      body: JSON.stringify({ id: 42, name: 'X' }),
      name: 'X',
    });
    const c = await getCandidateById(env, 42);
    expect(c.name).toBe('X');
    expect(c.id).toBe(42);
  });

  it('getCandidateById returns null on miss', async () => {
    expect(await getCandidateById(env, 999)).toBeNull();
  });

  it('getCandidateByEmail returns null on miss', async () => {
    expect(await getCandidateByEmail(env, 'nope@x.com')).toBeNull();
  });

  it('getCandidateByEmail is case-insensitive on the input', async () => {
    // Sync-worker stores primary_email already lower-cased, so the helper
    // only needs to lower-case the query side.
    await insertCandidate({
      id: 1,
      body: JSON.stringify({ id: 1, email: 'joe@example.com' }),
      primary_email: 'joe@example.com',
    });
    const c = await getCandidateByEmail(env, 'JOE@Example.COM');
    expect(c?.id).toBe(1);
  });

  it('getCandidateByLinkedIn matches lower-cased slug', async () => {
    await insertCandidate({
      id: 7,
      body: JSON.stringify({ id: 7 }),
      linkedin_profile: 'jane-doe',
    });
    const hit = await getCandidateByLinkedIn(env, 'Jane-Doe');
    expect(hit?.id).toBe(7);
    const miss = await getCandidateByLinkedIn(env, 'someone-else');
    expect(miss).toBeNull();
  });

  it('countTable counts rows', async () => {
    expect(await countTable(env, 'candidates')).toBe(0);
    await insertCandidate({ id: 1, body: '{}' });
    await insertCandidate({ id: 2, body: '{}' });
    expect(await countTable(env, 'candidates')).toBe(2);
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
