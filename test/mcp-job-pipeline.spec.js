import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import worker from '../src';

const KV_KEYS = [
  'mcp:pipeline:100',
  'mcp:pipeline:200',
  'mcp:pipeline:999',
  'mcp:job-candidates:100',
  'mcp:job-candidates:200',
  'mcp:job-candidates:999',
];

const insertJob = async (id, name = 'Job ' + id, client = 'Acme') => {
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, JSON.stringify({ id, name }), name, client, new Date().toISOString())
    .run();
};

const insertCandidate = async (id, name, body = {}) => {
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO candidates (id, body, name, cached_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, JSON.stringify({ id, name, ...body }), name, new Date().toISOString())
    .run();
};

const linkJob = async (candidateId, jobId, stage, opts = {}) => {
  await env.RF_MCP_CACHE
    .prepare(
      `INSERT INTO candidate_jobs
        (candidate_id, job_id, stage_id, stage_name, stage_moved,
         added_to_job, added_to_job_by_id, disqualified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      candidateId,
      jobId,
      opts.stage_id ?? 1,
      stage,
      opts.stage_moved ?? '2026-05-01T00:00:00Z',
      opts.added_to_job ?? '2026-05-01T00:00:00Z',
      opts.added_to_job_by_id ?? 100,
      opts.disqualified ?? 0,
    )
    .run();
};

beforeEach(async () => {
  await applyMigration(env);
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  for (const k of KV_KEYS) await env.SYNC_STATE.delete(k);
});

const call = (b) =>
  worker.fetch(
    new Request('http://x/mcp/job-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify(b),
    }),
    env,
    createExecutionContext(),
  );

describe('/mcp/job-pipeline', () => {
  it('returns pre-built KV snapshot', async () => {
    const snap = {
      job: { id: 100, name: 'Eng Lead', client_company_name: 'Acme' },
      stages: [
        { stage_name: 'CV Sent', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: '2026-05-01T00:00:00Z' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
    expect(b.stages).toHaveLength(1);
    expect(b.stages[0].candidates[0].id).toBe(1);
  });

  it('falls back to D1 build on KV miss + writes back to KV', async () => {
    await insertJob(100, 'Eng Lead', 'Acme');
    await insertCandidate(1, 'Alice');
    // CV Sent is in the default range (CV Sent → Offer) so the no-param call
    // surfaces the candidate.
    await linkJob(1, 100, 'CV Sent');

    expect(await env.SYNC_STATE.get('mcp:pipeline:100')).toBeNull();
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
    expect(b.stages[0].stage_name).toBe('CV Sent');
    expect(b.stages[0].candidates[0].id).toBe(1);

    // KV writeback so subsequent reads skip D1.
    const written = await env.SYNC_STATE.get('mcp:pipeline:100');
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written);
    expect(parsed.job.id).toBe(100);
    expect(parsed.stages[0].count).toBe(1);
  });

  it('narrows to a single stage when stage provided', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: 'CV Sent', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'CV Sent' });
    const b = await r.json();
    expect(b.stages).toHaveLength(1);
    expect(b.stages[0].stage_name).toBe('CV Sent');
    expect(b.stages[0].candidates[0].id).toBe(2);
  });

  it('submitted: true filters from CV Sent to end of this job\'s pipeline', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      pipeline_stages: [
        { id: 1, name: 'Sourced' },
        { id: 2, name: 'Replied' },
        { id: 3, name: 'CV Sent' },
        { id: 4, name: '1st Interview' },
        { id: 5, name: 'Hired' },
      ],
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: 'Replied', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
        { stage_name: 'CV Sent', count: 1, candidates: [{ id: 3, name: 'C', stage_moved: 't' }] },
        { stage_name: '1st Interview', count: 1, candidates: [{ id: 4, name: 'D', stage_moved: 't' }] },
        { stage_name: 'Hired', count: 1, candidates: [{ id: 5, name: 'E', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, submitted: true });
    const b = await r.json();
    const stageNames = b.stages.map((s) => s.stage_name);
    expect(stageNames).toEqual(['CV Sent', '1st Interview', 'Hired']);
  });

  it('returns 404 for unknown job (no KV, no D1 row)', async () => {
    const r = await call({ consultantFirstName: 'Joel', job: 999 });
    expect(r.status).toBe(404);
  });

  it('numeric job id passed as string still works', async () => {
    await insertJob(100, 'Eng Lead', 'Acme');
    await insertCandidate(1, 'Alice');
    await linkJob(1, 100, 'CV Sent');
    const r = await call({ consultantFirstName: 'Joel', job: '100' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
  });

  it('fuzzy job name resolves and returns the right pipeline', async () => {
    await insertJob(100, 'Enterprise AE', 'Nominal');
    await insertJob(200, 'CSM Lead', 'Other');
    await insertCandidate(1, 'Alice');
    await linkJob(1, 100, 'CV Sent');
    const r = await call({ consultantFirstName: 'Joel', job: 'Enterprise AE' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.job.id).toBe(100);
  });

  it('ambiguous fuzzy job name → needs_disambiguation kind=job', async () => {
    await insertJob(100, 'Enterprise AE', 'Acme');
    await insertJob(200, 'Enterprise AE', 'Globex');
    const r = await call({ consultantFirstName: 'Joel', job: 'Enterprise AE' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('job');
    expect(b.options).toHaveLength(2);
  });

  it('unknown fuzzy job name → 404', async () => {
    await insertJob(100, 'Enterprise AE', 'Nominal');
    const r = await call({ consultantFirstName: 'Joel', job: 'totally-not-a-real-job' });
    expect(r.status).toBe(404);
  });

  it('lowercase stage name resolves to canonical', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: 'CV Sent', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'sourced' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.stages).toHaveLength(1);
    expect(b.stages[0].stage_name).toBe('Sourced');
    expect(b.stages[0].candidates[0].id).toBe(1);
  });

  it('prefix stage name resolves ("1st" → "1st Interview")', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: '1st Interview', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: '1st' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.stages).toHaveLength(1);
    expect(b.stages[0].stage_name).toBe('1st Interview');
  });

  it('ambiguous stage ("interview") → 200 needs_disambiguation kind=stage', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      stages: [
        { stage_name: '1st Interview', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: '2nd Interview', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
        { stage_name: 'Final Interview', count: 1, candidates: [{ id: 3, name: 'C', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    expect(b.options.length).toBeGreaterThanOrEqual(2);
    expect(b.hint).toMatch(/multiple/i);
  });

  it('unknown stage name falls through to filter (empty stages, not 404)', async () => {
    const snap = {
      job: { id: 100, name: 'J', client_company_name: 'C' },
      stages: [
        { stage_name: 'Sourced', count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));
    const r = await call({ consultantFirstName: 'Joel', job: 100, stage: 'totally-not-a-real-stage' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.stages).toEqual([]);
  });

  // Helper: snapshot for a job whose pipeline mirrors the standard recruiting
  // taxonomy. Each candidate sits in one stage; the `pipeline_stages` array
  // carries the per-job pipeline order (this is what sync-worker extracts
  // from a candidate's body.jobs[k].stages and writes alongside `stages`).
  const fullSnap = (jobId = 100) => {
    const pipeline_stages = [
      { id: 1, name: 'Sourced' },
      { id: 2, name: 'Replied' },
      { id: 3, name: 'Call Booked' },
      { id: 4, name: 'CV Sent' },
      { id: 5, name: '1st Interview' },
      { id: 6, name: '2nd Interview' },
      { id: 7, name: 'Final Interview' },
      { id: 8, name: 'Offer' },
      { id: 9, name: 'Hired' },
    ];
    return {
      job: { id: jobId, name: 'Eng Lead', client_company_name: 'Acme' },
      pipeline_stages,
      stages: pipeline_stages.map((s, i) => ({
        stage_name: s.name,
        count: 1,
        candidates: [{ id: 11 + i, name: String.fromCharCode(97 + i), stage_moved: 't' }],
      })),
    };
  };

  it('default (no params) returns CV Sent → Offer only', async () => {
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(fullSnap()));
    const r = await call({ consultantFirstName: 'Joel', job: 100 });
    expect(r.status).toBe(200);
    const b = await r.json();
    const names = b.stages.map((s) => s.stage_name);
    expect(names).toEqual(['CV Sent', '1st Interview', '2nd Interview', 'Final Interview', 'Offer']);
  });

  it('from: "Replied" returns Replied → Hired', async () => {
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(fullSnap()));
    const r = await call({ consultantFirstName: 'Joel', job: 100, from: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    const names = b.stages.map((s) => s.stage_name);
    expect(names).toEqual([
      'Replied', 'Call Booked', 'CV Sent', '1st Interview',
      '2nd Interview', 'Final Interview', 'Offer', 'Hired',
    ]);
  });

  it('to: "1st Interview" returns Sourced → 1st Interview', async () => {
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(fullSnap()));
    const r = await call({ consultantFirstName: 'Joel', job: 100, to: '1st Interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    const names = b.stages.map((s) => s.stage_name);
    expect(names).toEqual(['Sourced', 'Replied', 'Call Booked', 'CV Sent', '1st Interview']);
  });

  it('from + to combine into a custom range', async () => {
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(fullSnap()));
    const r = await call({
      consultantFirstName: 'Joel', job: 100,
      from: 'Replied', to: 'CV Sent',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    const names = b.stages.map((s) => s.stage_name);
    expect(names).toEqual(['Replied', 'Call Booked', 'CV Sent']);
  });

  it('lowercase from is fuzzy-resolved', async () => {
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(fullSnap()));
    const r = await call({ consultantFirstName: 'Joel', job: 100, from: 'replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.stages[0].stage_name).toBe('Replied');
  });

  it('ambiguous from ("interview") returns 200 needs_disambiguation kind=stage', async () => {
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(fullSnap()));
    const r = await call({ consultantFirstName: 'Joel', job: 100, from: 'interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    expect(b.options.length).toBeGreaterThanOrEqual(2);
  });

  it('per-job pipeline: custom stages resolve fuzzy and filter correctly', async () => {
    // This job has a non-standard pipeline (Phone Screen + Take-home + Onsite
    // — no "Final Interview"). Range and `submitted` semantics resolve
    // landmarks ("CV Sent", "Offer") fuzzily against THIS pipeline; custom
    // stages between the landmarks survive the default range too.
    const snap = {
      job: { id: 100, name: 'Backend Eng', client_company_name: 'CustomCorp' },
      pipeline_stages: [
        { id: 1, name: 'Sourced' },
        { id: 2, name: 'Phone Screen' },
        { id: 3, name: 'CV Sent' },
        { id: 4, name: 'Take-home' },
        { id: 5, name: 'Onsite' },
        { id: 6, name: 'Offer' },
        { id: 7, name: 'Hired' },
      ],
      stages: [
        { stage_name: 'Sourced',      count: 1, candidates: [{ id: 1, name: 'A', stage_moved: 't' }] },
        { stage_name: 'Phone Screen', count: 1, candidates: [{ id: 2, name: 'B', stage_moved: 't' }] },
        { stage_name: 'CV Sent',      count: 1, candidates: [{ id: 3, name: 'C', stage_moved: 't' }] },
        { stage_name: 'Take-home',    count: 1, candidates: [{ id: 4, name: 'D', stage_moved: 't' }] },
        { stage_name: 'Onsite',       count: 1, candidates: [{ id: 5, name: 'E', stage_moved: 't' }] },
        { stage_name: 'Offer',        count: 1, candidates: [{ id: 6, name: 'F', stage_moved: 't' }] },
        { stage_name: 'Hired',        count: 1, candidates: [{ id: 7, name: 'G', stage_moved: 't' }] },
      ],
    };
    await env.SYNC_STATE.put('mcp:pipeline:100', JSON.stringify(snap));

    // Default (CV Sent → Offer, fuzzy on this pipeline) — picks up the
    // custom Take-home and Onsite stages between the landmarks.
    const dflt = await (await call({ consultantFirstName: 'Joel', job: 100 })).json();
    expect(dflt.stages.map((s) => s.stage_name)).toEqual([
      'CV Sent', 'Take-home', 'Onsite', 'Offer',
    ]);

    // Fuzzy `from: "phone"` resolves to the custom "Phone Screen" stage and
    // returns everything from there to the end.
    const phone = await (await call({ consultantFirstName: 'Joel', job: 100, from: 'phone' })).json();
    expect(phone.stages.map((s) => s.stage_name)).toEqual([
      'Phone Screen', 'CV Sent', 'Take-home', 'Onsite', 'Offer', 'Hired',
    ]);
  });
});
