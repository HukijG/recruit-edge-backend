import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-move-stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  resetSnapshot();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (?, ?, ?, ?)'
  ).bind(42, JSON.stringify({
    id: 42, name: 'Jerry Smith',
    jobs: [{
      job_id: 100, job_name: 'Eng', stage_id: 1, stage_name: 'Sourced',
      disqualified: false,
      stages: [
        { id: 1, name: 'Sourced' },
        { id: 2, name: 'Replied' },
        { id: 3, name: 'Call Booked' },
        { id: 4, name: '1st Interview' },
        { id: 5, name: '2nd Interview' },
      ],
    }],
  }), 'Jerry Smith', new Date().toISOString()).run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('/mcp/candidate-move-stage', () => {
  it('round-trips to RF and returns success with from/to stage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.moved.candidate_id).toBe(42);
    expect(b.moved.candidate_name).toBe('Jerry Smith');
    expect(b.moved.job_id).toBe(100);
    expect(b.moved.from_stage).toBe('Sourced');
    expect(b.moved.to_stage).toBe('Replied');

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = globalThis.fetch.mock.calls[0];
    expect(String(calledUrl)).toContain('/candidate/move-to-stage');
    expect(calledOpts.method).toBe('POST');
    const sent = JSON.parse(calledOpts.body);
    expect(sent).toMatchObject({
      id: 42,
      job_id: 100,
      stage: { id: 2, name: 'Replied' },
      user_id: 900001,  // Joel's rfUserId
    });
  });

  it('returns disambiguation when candidate has multiple non-DQ jobs and no job specified', async () => {
    await env.RF_MCP_CACHE.prepare(
      'UPDATE candidates SET body = ? WHERE id = 42'
    ).bind(JSON.stringify({
      id: 42, name: 'Jerry Smith',
      jobs: [
        { job_id: 100, job_name: 'Eng', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
        { job_id: 200, job_name: 'PM', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
      ],
    })).run();

    // No fetch mock — RF must not be called when we disambiguate.
    globalThis.fetch = vi.fn();

    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('job');
    expect(b.options).toHaveLength(2);
    expect(b.options[0]).toMatchObject({ job_id: 100, job_name: 'Eng' });
    expect(b.options[1]).toMatchObject({ job_id: 200, job_name: 'PM' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown candidate id', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 999, stage: 'Replied' });
    expect(r.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 for stage not found on job', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'NotARealStage' });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toContain('NotARealStage');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fuzzy candidate name resolves uniquely and round-trips to RF', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate: 'Jerry Smith', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.moved.candidate_id).toBe(42);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('numeric candidate id passed as string still works', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate: '42', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.candidate_id).toBe(42);
  });

  it('ambiguous fuzzy candidate name returns needs_disambiguation kind=candidate', async () => {
    // Insert a second Jerry to force ambiguity. With post-narrow, the second
    // Jerry needs a job + Replied stage so it produces a valid tuple too;
    // otherwise post-narrow would auto-resolve to the first Jerry as the
    // sole owner of a valid (candidate, job, stage) chain.
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      43, JSON.stringify({
        id: 43, name: 'Kevin Park',
        jobs: [{
          job_id: 200, job_name: 'CSM Lead', stage_id: 1, stage_name: 'Sourced',
          disqualified: false,
          stages: [
            { id: 1, name: 'Sourced' },
            { id: 2, name: 'Replied' },
          ],
        }],
      }),
      'Kevin Park', 'Globex', 'CSM', new Date().toISOString()
    ).run();
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 'Jerry', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('candidate');
    expect(b.options.length).toBeGreaterThanOrEqual(2);
    expect(b.options[0]).toHaveProperty('current_organization');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('post-narrow: two Jerries but only one is on the specified job → auto-commits', async () => {
    // Jerry-1 (id=42) is on Eng (job_id=100). Insert Jerry-2 on a DIFFERENT
    // job (job_id=300, "Sales Lead"). Caller asks for "Jerry to Replied on
    // Eng" — only Jerry-1 has Eng, so the post-narrow should collapse to a
    // unique tuple and commit without disambiguation.
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      43, JSON.stringify({
        id: 43, name: 'Kevin Park',
        jobs: [{
          job_id: 300, job_name: 'Sales Lead', stage_id: 1, stage_name: 'Sourced',
          disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
        }],
      }),
      'Kevin Park', 'Globex', 'CSM', new Date().toISOString()
    ).run();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      candidate: 'Jerry',
      job: 'Eng',
      stage: 'Replied',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.moved.candidate_id).toBe(42);
    expect(b.moved.job_id).toBe(100);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('post-narrow: two Jerries on differently-named jobs, both share Replied → kind=candidate options carry job context', async () => {
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      43, JSON.stringify({
        id: 43, name: 'Kevin Park',
        jobs: [{
          job_id: 300, job_name: 'CSM Lead', stage_id: 1, stage_name: 'Sourced',
          disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
        }],
      }),
      'Kevin Park', 'Globex', 'CSM', new Date().toISOString()
    ).run();
    globalThis.fetch = vi.fn();
    // No `job` filter — both Jerries produce a valid (Replied) tuple.
    const r = await call({ consultantFirstName: 'Joel', candidate: 'Jerry', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('candidate');
    expect(b.options).toHaveLength(2);
    // Each option should carry both candidate identity AND the per-tuple job
    // context so the consumer renders an unambiguous line per option.
    for (const opt of b.options) {
      expect(opt).toHaveProperty('id');           // candidate id
      expect(opt).toHaveProperty('name');         // candidate name
      expect(opt).toHaveProperty('current_organization');
      expect(opt).toHaveProperty('job_name');     // tuple context
      expect(opt).toHaveProperty('to_stage');
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('post-narrow: single candidate, single job, ambiguous stage → kind=stage (legacy preserved)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    const names = b.options.map((o) => o.name).sort();
    expect(names).toContain('1st Interview');
    expect(names).toContain('2nd Interview');
  });

  it('fuzzy stage name resolves ("call booked" → Call Booked)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'call booked' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.to_stage).toBe('Call Booked');
  });

  it('fuzzy stage name partial match ("1st" → 1st Interview)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: '1st' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.to_stage).toBe('1st Interview');
  });

  it('ambiguous stage name returns needs_disambiguation kind=stage', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, stage: 'Interview' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('stage');
    const names = b.options.map((o) => o.name).sort();
    expect(names).toContain('1st Interview');
    expect(names).toContain('2nd Interview');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fuzzy job name resolves against the candidate jobs[]', async () => {
    // Add a second job to the candidate so `job` actually has work to do.
    await env.RF_MCP_CACHE.prepare(
      'UPDATE candidates SET body = ? WHERE id = 42'
    ).bind(JSON.stringify({
      id: 42, name: 'Jerry Smith',
      jobs: [
        { job_id: 100, job_name: 'Enterprise AE', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
        { job_id: 200, job_name: 'CSM Lead', stage_name: 'Sourced', disqualified: false,
          stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }] },
      ],
    })).run();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate: 42, job: 'Enterprise AE', stage: 'Replied' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.moved.job_id).toBe(100);
  });

  it('candidate_id + job_id + stage_id = direct commit, no resolver', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, job_id: 100, stage_id: 2 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.moved.candidate_id).toBe(42);
    expect(body.moved.to_stage).toBe('Replied');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('candidate_id alone falls through to fuzzy job/stage path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, stage: 'replied' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.moved.to_stage).toBe('Replied');
  });

  it('candidate_id with non-existent id returns 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 99999, job_id: 100, stage_id: 2 });
    expect(r.status).toBe(404);
  });

  it('candidate_id + wrong job_id returns 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, job_id: 999, stage_id: 2 });
    expect(r.status).toBe(404);
  });

  it('candidate_id + job_id + bad stage_id returns 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await call({ consultantFirstName: 'Joel', candidate_id: 42, job_id: 100, stage_id: 9999 });
    expect(r.status).toBe(404);
  });
});
