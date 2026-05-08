import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/migrate.js';
import { runPipelineRebuild } from '../src/pipeline-workflow.js';
import * as rfClient from '../src/rf-list-client.js';
import { readSyncState, writeSyncState, deleteSyncState } from '../src/sync-state.js';

const stepShim = {
  do: async (_name, optsOrFn, maybeFn) => {
    const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
    return fn();
  },
};

beforeEach(async () => {
  await applyMigration(env.RF_MCP_CACHE);
  await deleteSyncState(env, 'in_flight');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertOpenJob(id, name = 'Job ' + id) {
  await env.RF_MCP_CACHE
    .prepare(`INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
              VALUES (?, ?, ?, ?, 1, ?)`)
    .bind(id, JSON.stringify({ id, name }), name, 'Acme', new Date().toISOString())
    .run();
}

describe('runPipelineRebuild', () => {
  it('rebuilds every open job when no params.jobIds passed', async () => {
    await insertOpenJob(101);
    await insertOpenJob(102);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockImplementation(async (_env, jobId) => ({
      summary: [{ id: 1, name: 'Sourced', count: 1 }],
      detail: [{ candidate: { id: 1000 + jobId, name: 'X' }, stages: [{ from: null, time: '2026-05-01T00:00:00+0000', to: 'Sourced' }] }],
    }));
    await runPipelineRebuild(env, stepShim, 'inst-1');
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT job_id FROM job_pipelines ORDER BY job_id')
      .all();
    expect(results.map((r) => r.job_id)).toEqual([101, 102]);
  });

  it('respects params.jobIds and skips other open jobs', async () => {
    await insertOpenJob(101);
    await insertOpenJob(102);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({
      summary: [{ id: 1, name: 'Sourced', count: 0 }],
      detail: [],
    });
    await runPipelineRebuild(env, stepShim, 'inst-2', { jobIds: [102] });
    const { results } = await env.RF_MCP_CACHE
      .prepare('SELECT job_id FROM job_pipelines ORDER BY job_id')
      .all();
    expect(results.map((r) => r.job_id)).toEqual([102]);
  });

  it('claims and releases the in-flight token', async () => {
    await insertOpenJob(101);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({ summary: [], detail: [] });
    await runPipelineRebuild(env, stepShim, 'inst-3');
    expect(await readSyncState(env, 'in_flight')).toBeFalsy();
  });

  it('refuses to run when in_flight is already set', async () => {
    await writeSyncState(env, 'in_flight', 'rebuild:other');
    await expect(runPipelineRebuild(env, stepShim, 'inst-4')).rejects.toThrow(/in flight/i);
  });

  it('writes last_pipeline_rebuild_at on completion', async () => {
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({ summary: [], detail: [] });
    await runPipelineRebuild(env, stepShim, 'inst-5');
    const stamp = await readSyncState(env, 'last_pipeline_rebuild_at');
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('releases the in-flight token even on per-job failure', async () => {
    await insertOpenJob(101);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockRejectedValue(new Error('boom'));
    await expect(runPipelineRebuild(env, stepShim, 'inst-6')).rejects.toThrow(/boom/);
    expect(await readSyncState(env, 'in_flight')).toBeFalsy();
  });

  it('drops Disqualified candidates from stage_candidates_json', async () => {
    await insertOpenJob(101);
    vi.spyOn(rfClient, 'fetchJobPipeline').mockResolvedValue({
      summary: [{ id: 1, name: 'Sourced', count: 1 }, { id: 2, name: 'Disqualified', count: 1 }],
      detail: [
        { candidate: { id: 1, name: 'A' }, stages: [{ from: null, time: '2026-05-01T00:00:00+0000', to: 'Sourced' }] },
        { candidate: { id: 2, name: 'B' }, stages: [
          { from: null, time: '2026-05-01T00:00:00+0000', to: 'Sourced' },
          { from: 'Sourced', time: '2026-05-02T00:00:00+0000', to: 'Disqualified' },
        ]},
      ],
    });
    await runPipelineRebuild(env, stepShim, 'inst-7');
    const row = await env.RF_MCP_CACHE
      .prepare('SELECT stage_candidates_json FROM job_pipelines WHERE job_id = 101')
      .first();
    expect(JSON.parse(row.stage_candidates_json)).toEqual({ Sourced: [1] });
  });
});
