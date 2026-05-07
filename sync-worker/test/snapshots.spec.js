import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigration } from './helpers/migrate.js';
import { rebuildMcpSnapshots, buildJobSnapshots } from '../src/snapshots.js';
import { writeCandidatesAndLinks, writeJobs } from '../src/d1-write.js';

const cand = (id, jobs) => ({
  id,
  first_name: `F${id}`,
  last_name: `L${id}`,
  name: `F${id} L${id}`,
  primary_email: `c${id}@x.com`,
  phone_numbers: [{ phone_number: `+440000000${id}` }],
  linkedin_profile: `https://linkedin.com/in/f${id}`,
  current_title: `Title ${id}`,
  current_organization: `Org ${id}`,
  jobs,
});

/**
 * Wipe every `mcp:*` KV key so each test starts from a clean slate.
 * `isolatedStorage: false` (required because of the workflow binding)
 * means KV state leaks across tests in the same file unless cleared.
 */
async function clearMcpKv() {
  let cursor = undefined;
  for (;;) {
    const list = await env.SYNC_STATE.list({ prefix: 'mcp:', cursor });
    await Promise.all(list.keys.map(k => env.SYNC_STATE.delete(k.name)));
    if (list.list_complete) break;
    cursor = list.cursor;
  }
}

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
  await clearMcpKv();
});

describe('snapshots', () => {
  it('rebuildMcpSnapshots writes pipeline + job-candidates KV keys', async () => {
    await writeJobs(env, [
      { id: 100, name: 'Eng', client_company_name: 'Acme', is_open: 1 },
    ]);
    await writeCandidatesAndLinks(env, [
      cand(1, [{ job_id: 100, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } }]),
      cand(2, [{ job_id: 100, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } }]),
      cand(3, [{ job_id: 100, stage_name: 'Hired',   disqualified: false, added_to_job_by: { id: 1 } }]),
    ]);

    await rebuildMcpSnapshots(env, null);

    const pipe = JSON.parse(await env.SYNC_STATE.get('mcp:pipeline:100'));
    expect(pipe.job.id).toBe(100);
    expect(pipe.job.name).toBe('Eng');
    expect(pipe.job.client_company_name).toBe('Acme');
    expect(pipe.stages.find(s => s.stage_name === 'Sourced').count).toBe(2);
    expect(pipe.stages.find(s => s.stage_name === 'Hired').count).toBe(1);

    const list = JSON.parse(await env.SYNC_STATE.get('mcp:job-candidates:100'));
    expect(list.total).toBe(3);
    expect(list.matched).toHaveLength(3);
    expect(list.matched[0]).toHaveProperty('linkedin_profile');
    expect(list.matched[0]).toHaveProperty('primary_phone');
    // Phone shape: body.phone_numbers[0].phone_number must surface as primary_phone.
    expect(list.matched[0].primary_phone).toMatch(/^\+44/);
    // LinkedIn: stored as the normalised slug, not the full URL.
    expect(list.matched[0].linkedin_profile).toMatch(/^f\d$/);
  });

  it('disqualified candidates are excluded from snapshots', async () => {
    await writeJobs(env, [
      { id: 100, name: 'Eng', client_company_name: 'Acme', is_open: 1 },
    ]);
    await writeCandidatesAndLinks(env, [
      cand(1, [{ job_id: 100, stage_name: 'Sourced', disqualified: true, added_to_job_by: { id: 1 } }]),
    ]);

    await rebuildMcpSnapshots(env, null);

    const list = JSON.parse(await env.SYNC_STATE.get('mcp:job-candidates:100'));
    expect(list.matched).toEqual([]);
    expect(list.total).toBe(0);
  });

  it('closed jobs are skipped when affectedJobIds=null', async () => {
    await writeJobs(env, [
      { id: 100, name: 'Open Job',   client_company_name: 'Acme',   is_open: 1 },
      { id: 200, name: 'Closed Job', client_company_name: 'Closed', is_open: 0 },
    ]);
    await writeCandidatesAndLinks(env, [
      cand(1, [{ job_id: 100, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } }]),
      cand(2, [{ job_id: 200, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } }]),
    ]);

    await rebuildMcpSnapshots(env, null);

    expect(await env.SYNC_STATE.get('mcp:pipeline:100')).not.toBeNull();
    expect(await env.SYNC_STATE.get('mcp:job-candidates:100')).not.toBeNull();
    expect(await env.SYNC_STATE.get('mcp:pipeline:200')).toBeNull();
    expect(await env.SYNC_STATE.get('mcp:job-candidates:200')).toBeNull();
  });

  it('pipeline snap includes pipeline_stages extracted from candidate body', async () => {
    const stages = [
      { id: 1, name: 'Sourced' },
      { id: 2, name: 'Replied' },
      { id: 3, name: 'Phone Screen' },  // job-specific custom stage
      { id: 4, name: 'CV Sent' },
      { id: 5, name: 'Take-home' },     // job-specific custom stage
      { id: 6, name: 'Onsite' },
      { id: 7, name: 'Offer' },
      { id: 8, name: 'Hired' },
    ];
    await writeJobs(env, [
      { id: 100, name: 'Eng', client_company_name: 'Acme', is_open: 1 },
    ]);
    await writeCandidatesAndLinks(env, [
      cand(1, [{ job_id: 100, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 }, stages }]),
    ]);

    await rebuildMcpSnapshots(env, null);

    const pipe = JSON.parse(await env.SYNC_STATE.get('mcp:pipeline:100'));
    expect(pipe.pipeline_stages).toEqual(stages);
  });

  it('affectedJobIds filters to specific jobs', async () => {
    await writeJobs(env, [
      { id: 100, name: 'A', client_company_name: 'Acme',  is_open: 1 },
      { id: 200, name: 'B', client_company_name: 'Bravo', is_open: 1 },
      { id: 300, name: 'C', client_company_name: 'Cargo', is_open: 1 },
    ]);
    await writeCandidatesAndLinks(env, [
      cand(1, [{ job_id: 100, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } }]),
      cand(2, [{ job_id: 200, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } }]),
      cand(3, [{ job_id: 300, stage_name: 'Sourced', disqualified: false, added_to_job_by: { id: 1 } }]),
    ]);

    await rebuildMcpSnapshots(env, [100, 200]);

    expect(await env.SYNC_STATE.get('mcp:pipeline:100')).not.toBeNull();
    expect(await env.SYNC_STATE.get('mcp:pipeline:200')).not.toBeNull();
    expect(await env.SYNC_STATE.get('mcp:pipeline:300')).toBeNull();
    expect(await env.SYNC_STATE.get('mcp:job-candidates:300')).toBeNull();
  });
});
