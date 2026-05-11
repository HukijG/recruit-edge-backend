import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/migrate.js';
import { writeCandidatesAndLinks, writeJobs, writeJobPipeline, writeCandidatesThin, writeJobsThin, writeCalls } from '../src/d1-write.js';

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

describe('writeJobPipeline', () => {
  it('inserts a new row', async () => {
    await writeJobPipeline(env, 984, [{ id: 1, name: 'Sourced', count: 5 }], { Sourced: [10, 11] });
    const row = await env.RF_MCP_CACHE
      .prepare('SELECT job_id, summary_json, stage_candidates_json FROM job_pipelines WHERE job_id = ?')
      .bind(984)
      .first();
    expect(row.job_id).toBe(984);
    expect(JSON.parse(row.summary_json)).toEqual([{ id: 1, name: 'Sourced', count: 5 }]);
    expect(JSON.parse(row.stage_candidates_json)).toEqual({ Sourced: [10, 11] });
  });

  it('replaces an existing row', async () => {
    await writeJobPipeline(env, 984, [{ id: 1, name: 'A', count: 1 }], { A: [1] });
    await writeJobPipeline(env, 984, [{ id: 1, name: 'B', count: 0 }], { B: [] });
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT * FROM job_pipelines WHERE job_id = ?')
      .bind(984)
      .all();
    expect(results.length).toBe(1);
    expect(JSON.parse(results[0].summary_json)).toEqual([{ id: 1, name: 'B', count: 0 }]);
  });
});

describe('writeCandidatesThin', () => {
  const candidate = {
    id: 1,
    name: 'Jane Doe',
    linkedin_profile: 'jane-doe',
    added_time: '2024-06-01T12:00:00+0000',
    current_title: 'CTO',
    current_organization: 'Acme',
  };

  it('inserts a new candidate', async () => {
    await writeCandidatesThin(env, [candidate]);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id, name, linkedin_profile FROM candidates_v2 WHERE id = ?')
      .bind(1).all();
    expect(results).toEqual([{ id: 1, name: 'Jane Doe', linkedin_profile: 'jane-doe' }]);
  });

  it('is idempotent on PK collision (INSERT-OR-IGNORE)', async () => {
    await writeCandidatesThin(env, [candidate]);
    const updated = { ...candidate, name: 'CHANGED — should NOT overwrite' };
    await writeCandidatesThin(env, [updated]);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT name FROM candidates_v2 WHERE id = 1').all();
    expect(results[0].name).toBe('Jane Doe');
  });

  it('handles >100 rows by chunking', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      name: `c${i}`,
      added_time: '2024-06-01T12:00:00+0000',
    }));
    await writeCandidatesThin(env, many);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates_v2').all();
    expect(results[0].n).toBe(250);
  });

  it('no-op on empty array', async () => {
    await writeCandidatesThin(env, []);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT COUNT(*) AS n FROM candidates_v2').all();
    expect(results[0].n).toBe(0);
  });
});

describe('writeJobsThin', () => {
  const job = {
    id: 42,
    name: 'Senior SWE',
    company: { name: 'Acme' },
    created_time: '2024-01-15T09:00:00+0000',
  };

  it('inserts a new job', async () => {
    await writeJobsThin(env, [job]);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT id, name, client_company_name, canonical_pipeline_json FROM jobs_v2 WHERE id = 42').all();
    expect(results[0]).toEqual({ id: 42, name: 'Senior SWE', client_company_name: 'Acme', canonical_pipeline_json: null });
  });

  it('writes canonical_pipeline_json when provided as second arg map', async () => {
    const pipelineByJobId = new Map([[42, [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Hired' }]]]);
    await writeJobsThin(env, [job], { pipelineByJobId });
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT canonical_pipeline_json FROM jobs_v2 WHERE id = 42').all();
    expect(JSON.parse(results[0].canonical_pipeline_json)).toEqual([
      { id: 1, name: 'Sourced' }, { id: 2, name: 'Hired' },
    ]);
  });

  it('is idempotent on PK collision', async () => {
    await writeJobsThin(env, [job]);
    await writeJobsThin(env, [{ ...job, name: 'CHANGED' }]);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT name FROM jobs_v2 WHERE id = 42').all();
    expect(results[0].name).toBe('Senior SWE');
  });
});

describe('writeCalls', () => {
  const call = {
    call_id: 'c-1',
    target: { id: '8000000000000001' },
    contact: { id: 'shared_contact_pool_Company:X_uid_RF555' },
    date_started: 1717248000000,
    total_duration: 180000,
    direction: 'outbound',
  };

  it('inserts a new call', async () => {
    await writeCalls(env, [call]);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id, rf_candidate_id, duration_ms FROM calls WHERE call_id = ?')
      .bind('c-1').all();
    expect(results[0]).toEqual({ call_id: 'c-1', rf_candidate_id: 555, duration_ms: 180000 });
  });

  it('is idempotent on PK collision', async () => {
    await writeCalls(env, [call]);
    await writeCalls(env, [{ ...call, total_duration: 999 }]);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT duration_ms FROM calls WHERE call_id = ?').bind('c-1').all();
    expect(results[0].duration_ms).toBe(180000); // first write wins (INSERT-OR-IGNORE)
  });

  it('writes rf_candidate_id as NULL when contact id has no uid_RF marker (cold call)', async () => {
    const coldCall = {
      call_id: 'c-cold-1',
      target: { id: '8000000000000001' },
      contact: { id: 'unknown-contact-no-uid-suffix' },
      date_started: 1717248000000,
      total_duration: 60000,
      direction: 'inbound',
    };
    await writeCalls(env, [coldCall]);
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT call_id, rf_candidate_id FROM calls WHERE call_id = ?')
      .bind('c-cold-1').all();
    expect(results[0].call_id).toBe('c-cold-1');
    expect(results[0].rf_candidate_id).toBeNull();
  });
});
