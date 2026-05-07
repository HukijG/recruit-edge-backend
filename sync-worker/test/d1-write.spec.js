import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/migrate.js';
import { writeCandidatesAndLinks, writeJobs } from '../src/d1-write.js';

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
});

const sample = {
  id: 42,
  first_name: 'A',
  last_name: 'B',
  name: 'A B',
  primary_email: 'ab@example.com',
  jobs: [
    { job_id: 100, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } },
  ],
};

/**
 * Helper: build N job links for a candidate id.
 */
function jobsForCandidate(candidateId, jobIdStart, count) {
  return Array.from({ length: count }, (_, i) => ({
    job_id: jobIdStart + i,
    stage_name: 'Sourced',
    disqualified: false,
    added_to_job_by: { id: 1 },
  }));
}

describe('d1-write', () => {
  it('writes a candidate + its job links in one batch', async () => {
    await writeCandidatesAndLinks(env, [sample]);

    const c = await env.RF_MCP_CACHE
      .prepare('SELECT id, name FROM candidates WHERE id = 42')
      .first();
    expect(c.name).toBe('A B');

    const cj = await env.RF_MCP_CACHE
      .prepare('SELECT * FROM candidate_jobs WHERE candidate_id = 42')
      .all();
    expect(cj.results).toHaveLength(1);
    expect(cj.results[0].stage_name).toBe('Sourced');
    expect(cj.results[0].job_id).toBe(100);
  });

  it('replaces job links wholesale on re-upsert', async () => {
    await writeCandidatesAndLinks(env, [sample]);

    const updated = {
      ...sample,
      jobs: [
        { job_id: 200, stage_name: 'Hired', disqualified: false, added_to_job_by: { id: 1 } },
      ],
    };
    await writeCandidatesAndLinks(env, [updated]);

    const cj = await env.RF_MCP_CACHE
      .prepare('SELECT job_id FROM candidate_jobs WHERE candidate_id = 42')
      .all();
    expect(cj.results.map(r => r.job_id)).toEqual([200]);
  });

  it('writeJobs upserts jobs', async () => {
    await writeJobs(env, [
      { id: 100, name: 'Eng', client_company_name: 'Acme', is_open: 1 },
    ]);
    const j = await env.RF_MCP_CACHE
      .prepare('SELECT name, client_company_name, is_open FROM jobs WHERE id = 100')
      .first();
    expect(j.name).toBe('Eng');
    expect(j.client_company_name).toBe('Acme');
    expect(j.is_open).toBe(1);
  });

  it('writeJobs is a no-op for an empty array', async () => {
    await writeJobs(env, []);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM jobs')
      .all();
    expect(results[0].n).toBe(0);
  });

  it('writes a candidate with 50 jobs atomically (52 stmts in one batch)', async () => {
    // 1 candidate row + 1 DELETE + 50 link inserts = 52 statements, well under
    // the 100-statement D1 batch cap. All 50 link rows must land.
    const big = { ...sample, id: 7, jobs: jobsForCandidate(7, 1000, 50) };

    await writeCandidatesAndLinks(env, [big]);

    const cj = await env.RF_MCP_CACHE
      .prepare('SELECT job_id FROM candidate_jobs WHERE candidate_id = 7 ORDER BY job_id')
      .all();
    expect(cj.results).toHaveLength(50);
    expect(cj.results[0].job_id).toBe(1000);
    expect(cj.results[49].job_id).toBe(1049);
  });

  it('writes 5 candidates with 2 jobs each (20 stmts total) in a single batch', async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      id: 1000 + i,
      first_name: `F${i}`,
      last_name: `L${i}`,
      name: `F${i} L${i}`,
      primary_email: `c${i}@example.com`,
      jobs: jobsForCandidate(1000 + i, 5000 + i * 10, 2),
    }));

    await writeCandidatesAndLinks(env, candidates);

    const c = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates')
      .first();
    expect(c.n).toBe(5);

    const cj = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidate_jobs')
      .first();
    expect(cj.n).toBe(10);

    // Spot-check: candidate 1002 should have its two jobs.
    const links = await env.RF_MCP_CACHE
      .prepare('SELECT job_id FROM candidate_jobs WHERE candidate_id = 1002 ORDER BY job_id')
      .all();
    expect(links.results.map(r => r.job_id)).toEqual([5020, 5021]);
  });

  it('preserves all rows across a chunk boundary (>100 statements total)', async () => {
    // 30 candidates × (1 cand + 1 delete + 3 jobs) = 30 × 5 = 150 statements,
    // forcing at least 2 batches. No rows must be lost at the chunk boundary.
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      id: 2000 + i,
      first_name: `X${i}`,
      last_name: `Y${i}`,
      name: `X${i} Y${i}`,
      primary_email: `b${i}@example.com`,
      jobs: jobsForCandidate(2000 + i, 9000 + i * 10, 3),
    }));

    await writeCandidatesAndLinks(env, candidates);

    const c = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates')
      .first();
    expect(c.n).toBe(30);

    const cj = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidate_jobs')
      .first();
    expect(cj.n).toBe(90); // 30 × 3

    // Spot-check both ends and middle to confirm both chunks landed.
    for (const id of [2000, 2015, 2029]) {
      const { results } = await env.RF_MCP_CACHE
        .prepare('SELECT job_id FROM candidate_jobs WHERE candidate_id = ?')
        .bind(id)
        .all();
      expect(results).toHaveLength(3);
    }
  });

  it('is a no-op for an empty candidate array', async () => {
    await writeCandidatesAndLinks(env, []);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates')
      .all();
    expect(results[0].n).toBe(0);
  });
});
