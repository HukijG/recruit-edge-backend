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
} from './rf-list-client.js';
import { writeCandidatesAndLinks, writeJobs } from './d1-write.js';
import { readSyncState, writeSyncState, deleteSyncState } from './sync-state.js';
import { rebuildMcpSnapshots } from './snapshots.js';

const PAGE_SIZE = 500;
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
 * @param {object} env  - Worker env (D1, KV, RF_API_KEY, etc.)
 * @param {object} step - Workflow step API (or shim)
 * @param {string} instanceId - Workflow instance id (for the in-flight token)
 */
export async function runFullRebuild(env, step, instanceId) {
  await step.do('claim in-flight', async () => {
    if (await readSyncState(env, 'in_flight')) {
      throw new NonRetryableError('another sync in flight');
    }
    await writeSyncState(env, 'in_flight', `rebuild:${instanceId}`);
  });

  try {
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

    await step.do('rebuild mcp snapshots', async () =>
      rebuildMcpSnapshots(env, null),
    );

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
    return runFullRebuild(this.env, step, event.instanceId);
  }
}
