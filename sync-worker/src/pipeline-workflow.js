/**
 * pipeline-workflow.js — recurring rebuild of `job_pipelines` D1 rows.
 *
 * Runs every 15 min via cron (sibling to tailSync). Each open job → one
 * step.do that fetches RF /job/pipeline + writes a job_pipelines row.
 * Per-step retries (3 attempts, exponential backoff) come from the
 * Workflow runtime; one bad job's fetch failing doesn't block the rest.
 *
 * The full rebuild path reuses this module — `FullRebuildWorkflow`'s last
 * step delegates here with no params (every open job).
 *
 * Tests drive `runPipelineRebuild` directly via a step shim (same pattern
 * as `runFullRebuild`).
 */

import * as cfWorkers from 'cloudflare:workers';
import * as rfClient from './rf-list-client.js';
import { writeJobPipeline } from './d1-write.js';
import { readSyncState, writeSyncState, deleteSyncState } from './sync-state.js';
import { normalizePipelineDetail } from './pipeline-normalize.js';

const { WorkflowEntrypoint } = cfWorkers;
// `NonRetryableError` is only present on newer compatibility dates. The test
// runtime in vitest-pool-workers falls back to an older runtime where it's
// undefined; substitute a plain Error so tests still observe the throw.
const NonRetryableError = cfWorkers.NonRetryableError ?? Error;

const RETRY_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
};

/**
 * Drive a pipeline rebuild end-to-end. Works against either a real Workflow
 * `step` instance or a test shim (see `runFullRebuild` doc).
 *
 * @param {object} env
 * @param {object} step - Workflow step API or test shim
 * @param {string} instanceId
 * @param {{ jobIds?: number[] }} [params]
 */
export async function runPipelineRebuild(env, step, instanceId, params = {}) {
  await step.do('claim in-flight', async () => {
    if (await readSyncState(env, 'in_flight')) {
      throw new NonRetryableError('another sync in flight');
    }
    await writeSyncState(env, 'in_flight', `pipeline:${instanceId}`);
  });

  try {
    const targetIds = await step.do('select target jobs', async () => {
      if (Array.isArray(params.jobIds) && params.jobIds.length) return params.jobIds;
      const { results } = await env.RF_MCP_CACHE
        .prepare('SELECT id FROM jobs WHERE is_open = 1')
        .all();
      return (results ?? []).map((r) => r.id);
    });

    for (const jobId of targetIds) {
      const payload = await step.do(
        `fetch pipeline ${jobId}`,
        RETRY_OPTS,
        async () => rfClient.fetchJobPipeline(env, jobId),
      );
      await step.do(`write pipeline ${jobId}`, async () => {
        const summary = Array.isArray(payload?.summary) ? payload.summary : [];
        const stageCandidates = normalizePipelineDetail(payload?.detail);
        await writeJobPipeline(env, jobId, summary, stageCandidates);
      });
    }

    await step.do('record completion', async () => {
      await writeSyncState(env, 'last_pipeline_rebuild_at', new Date().toISOString());
    });
  } finally {
    // MUST run on both success and failure paths — a mid-run throw without
    // this would leave `in_flight` stuck until the watchdog clears it.
    await step.do('release in-flight', async () =>
      deleteSyncState(env, 'in_flight'),
    );
  }
}

export class PipelineRebuildWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runPipelineRebuild(this.env, step, event.instanceId, event.payload ?? {});
  }
}
