/**
 * workflow.js — FullRebuildWorkflow + the testable `runFullRebuild` core.
 *
 * The Workflow runtime can't be exercised end-to-end from vitest, so the
 * orchestration is split into:
 *   - `runFullRebuild(env, step, instanceId)` — pure-ish, takes a `step` shim
 *     so tests can drive it without the Workflow runtime.
 *   - `FullRebuildWorkflow extends WorkflowEntrypoint` — thin class whose
 *     `run(event, step)` delegates to `runFullRebuild`.
 *
 * The `step.do(...)` API has two call shapes — `step.do(name, fn)` and
 * `step.do(name, opts, fn)`. Tests pass a shim that handles both forms.
 *
 * In-flight token semantics:
 *   - The first step claims `sync_state.in_flight = "rebuild:{id}"` or throws
 *     a NonRetryableError if a token is already present (another sync racing).
 *   - The token is cleared in a `finally` block so a mid-run failure still
 *     releases it. Otherwise a single bad rebuild would lock out future ones
 *     until the watchdog kicks in.
 */

import * as cfWorkers from 'cloudflare:workers';

const { WorkflowEntrypoint } = cfWorkers;
// `NonRetryableError` is only present on newer compatibility dates. The test
// runtime in vitest-pool-workers falls back to an older runtime where it's
// undefined; substitute a plain Error so tests still observe the throw.
const NonRetryableError = cfWorkers.NonRetryableError ?? Error;
import {
  fetchCandidateListPage,
  fetchAllJobs,
  fetchUsers,
  fetchActivityTypes,
  fetchCustomFieldSchema,
  fetchJobPipeline,
} from './rf-list-client.js';
import {
  writeCandidatesAndLinks,
  writeJobs,
  writeJobPipeline,
  writeCandidatesThin,
  writeJobsThin,
  writeCalls,
} from './d1-write.js';
import { readSyncState, writeSyncState, deleteSyncState } from './sync-state.js';
import { normalizePipelineDetail } from './pipeline-normalize.js';
import { listConsultants } from './users-d1-read.js';
import { fetchCallsForConsultant } from './dialpad-list-client.js';

const PAGE_SIZE = 100;  // RF caps /candidate/list at 100/page
const RETRY_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
};

/**
 * Drive a full rebuild end-to-end. Works against either a real Workflow
 * `step` instance or a test shim — the shim form is:
 *
 *   const stepShim = {
 *     do: async (name, optsOrFn, maybeFn) => {
 *       const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
 *       return fn();
 *     },
 *   };
 *
 * @param {object} env        - Worker env (D1, KV, RF_API_KEY, etc.)
 * @param {object} step       - Workflow step API (or shim)
 * @param {string} instanceId - Workflow instance id (for the in-flight token)
 * @param {object} [params]   - Optional params; `params.only` gates sections
 *                              ('candidates' | 'jobs' | 'pipelines' | null=all)
 */
export async function runFullRebuild(env, step, instanceId, params = {}) {
  await step.do('claim in-flight', async () => {
    if (await readSyncState(env, 'in_flight')) {
      throw new NonRetryableError('another sync in flight');
    }
    await writeSyncState(env, 'in_flight', `rebuild:${instanceId}`);
  });

  const only = params.only ?? null;
  const wantCandidates = only == null || only === 'candidates';
  const wantJobs       = only == null || only === 'jobs';
  const wantPipelines  = only == null || only === 'pipelines';

  try {
    if (wantCandidates) {
      let page = 1;
      let total = 0;
      for (;;) {
        const { rows } = await step.do(
          `fetch page ${page}`,
          RETRY_OPTS,
          async () => fetchCandidateListPage(env, page, PAGE_SIZE),
        );
        if (rows.length === 0) break;
        await step.do(`write page ${page}`, async () =>
          writeCandidatesAndLinks(env, rows),
        );
        total += rows.length;
        if (page % 10 === 0) console.log(`[rebuild] page ${page} (${total})`);
        if (rows.length < PAGE_SIZE) break;
        page++;
      }
    }

    if (wantJobs) {
      await step.do('refresh jobs', async () => {
        const jobs = await fetchAllJobs(env);
        await writeJobs(env, jobs);
      });
      await step.do('refresh users', async () => {
        const users = await fetchUsers(env);
        await writeSyncState(env, 'users', JSON.stringify(users));
      });
      await step.do('refresh activity types', async () => {
        const at = await fetchActivityTypes(env);
        await writeSyncState(env, 'activity_types', JSON.stringify(at));
      });
      await step.do('refresh custom field schema', async () => {
        const cf = await fetchCustomFieldSchema(env);
        await writeSyncState(env, 'custom_field_schema', JSON.stringify(cf));
      });
    }

    if (wantPipelines) {
      await step.do('rebuild pipelines', async () => {
        const { results } = await env.RF_MCP_CACHE
          .prepare('SELECT id FROM jobs WHERE is_open = 1')
          .all();
        for (const j of results ?? []) {
          const payload = await fetchJobPipeline(env, j.id);
          const summary = Array.isArray(payload?.summary) ? payload.summary : [];
          const stageCandidates = normalizePipelineDetail(payload?.detail);
          await writeJobPipeline(env, j.id, summary, stageCandidates);
        }
      });
    }

    await step.do('record completion', async () => {
      const now = new Date().toISOString();
      await writeSyncState(env, 'last_full_rebuild_at', now);
      // Bump `last_tail_sync_at` too — the main worker keys its in-memory
      // fuzzy snapshot off this stamp; without the bump the snapshot stays
      // pinned to a stale version and post-rebuild reads serve old rows.
      await writeSyncState(env, 'last_tail_sync_at', now);
    });
  } finally {
    // MUST run on both success and failure paths — a mid-run throw without
    // this would leave `in_flight` stuck until the 6h watchdog clears it.
    await step.do('release in-flight', async () =>
      deleteSyncState(env, 'in_flight'),
    );
  }
}

export class FullRebuildWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runFullRebuild(this.env, step, event.instanceId, event.payload ?? {});
  }
}

const SEED_PAGE_SIZE = 100;

/**
 * Per-table seed driver. params.table ∈ {'candidates', 'jobs', 'calls'}.
 * params.since (ISO string, optional) bounds the calls lookback (default 2y).
 *
 * Step granularity: one step per page (candidates/calls) or one step total
 * (jobs — only ~100 rows). step.do retries on transient failures; the
 * INSERT-OR-IGNORE writers make any retry idempotent.
 */
export async function runCacheSeed(env, step, instanceId, params = {}) {
  const table = params.table;
  if (!['candidates', 'jobs', 'calls'].includes(table)) {
    throw new Error(`runCacheSeed: unknown table "${table}" (expected candidates|jobs|calls)`);
  }

  if (table === 'candidates') {
    // Seed loops until /candidate/list returns an empty page. Unlike the
    // tail-sync path, we DON'T early-break on rows.length < PAGE_SIZE — for
    // the one-shot initial seed it's safer to drain to a true empty page in
    // case RF ever serves a short non-final page.
    let page = 1;
    for (;;) {
      const { rows } = await step.do(
        `fetch candidates page ${page}`,
        RETRY_OPTS,
        async () => fetchCandidateListPage(env, page, SEED_PAGE_SIZE),
      );
      if (rows.length === 0) break;
      await step.do(`write candidates page ${page}`, async () =>
        writeCandidatesThin(env, rows),
      );
      page++;
    }
    return;
  }

  if (table === 'jobs') {
    const allJobs = await step.do('fetch all jobs', RETRY_OPTS, async () => fetchAllJobs(env));
    const pipelineByJobId = new Map();
    for (const job of allJobs) {
      try {
        const pipeline = await step.do(`fetch pipeline job=${job.id}`, RETRY_OPTS, async () =>
          fetchJobPipeline(env, job.id),
        );
        pipelineByJobId.set(job.id, pipeline?.summary ?? []);
      } catch (err) {
        console.warn({
          message: `[seed] /job/pipeline fetch failed job=${job.id}: ${err.message}`,
          source: 'cache-seed', subtask: 'jobs', jobId: job.id,
        });
      }
    }
    await step.do('write all jobs', async () => writeJobsThin(env, allJobs, { pipelineByJobId }));
    return;
  }

  if (table === 'calls') {
    const consultants = await step.do('list consultants', async () => listConsultants(env));
    const sinceMs = params.since ? Date.parse(params.since) : Date.now() - 2 * 365 * 24 * 3600_000;
    for (const c of consultants) {
      try {
        const calls = await step.do(`fetch calls user=${c.dialpadId}`, RETRY_OPTS, async () =>
          fetchCallsForConsultant(env, c.dialpadId, sinceMs),
        );
        // Chunk writes by 200 to keep individual D1 batches well under the cap.
        for (let i = 0; i < calls.length; i += 200) {
          await step.do(`write calls user=${c.dialpadId} chunk=${i}`, async () =>
            writeCalls(env, calls.slice(i, i + 200)),
          );
        }
      } catch (err) {
        console.error({
          message: `[seed] calls fetch/write failed user=${c.dialpadId}: ${err.message}`,
          source: 'cache-seed', subtask: 'calls', consultantDialpadId: c.dialpadId,
        });
      }
    }
    return;
  }
}

export class CacheSeedWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runCacheSeed(this.env, step, event.instanceId, event.payload);
  }
}
