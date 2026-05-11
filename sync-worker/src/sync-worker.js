import * as rfClient from './rf-list-client.js';
import {
  writeCandidatesAndLinks,
  writeJobs,
  writeCandidatesThin,
  writeJobsThin,
  writeCalls,
} from './d1-write.js';
import { readSyncState, writeSyncState, deleteSyncState } from './sync-state.js';
import { listConsultants } from './users-d1-read.js';
import { fetchCallsForConsultant } from './dialpad-list-client.js';

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) {
    // still iterate to avoid timing leak on length
    let dummy = 0;
    for (let i = 0; i < ea.length; i++) dummy |= ea[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function handleAdmin(request, env, ctx) {
  const token = request.headers.get('X-Admin-Token');
  if (!env.ADMIN_SECRET || !token || !timingSafeEqual(token, env.ADMIN_SECRET)) {
    return Response.json({ ok: false, error: 'auth' }, { status: 401 });
  }

  const url = new URL(request.url);
  if (url.pathname === '/admin/full-rebuild' && request.method === 'POST') {
    const only = url.searchParams.get('only');  // null | 'candidates' | 'jobs' | 'pipelines'
    const instance = await env.REBUILD_WORKFLOW.create({
      id: crypto.randomUUID(),
      params: { startedAt: new Date().toISOString(), only },
    });
    return Response.json({ ok: true, workflow_id: instance.id }, { status: 202 });
  }

  return new Response('not found', { status: 404 });
}

const WATCHDOG_HOURS = 6;
const SIX_HOURS_MS = 6 * 3600_000;
const ONE_DAY_MS = 24 * 3600_000;

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function watchdog(env) {
  const inFlight = await readSyncState(env, 'in_flight');
  if (!inFlight) return;
  const last = await readSyncState(env, 'last_tail_sync_at');
  if (!last) return;
  const ageMs = Date.now() - Date.parse(last);
  if (ageMs > WATCHDOG_HOURS * 3600_000) {
    console.warn(`[sync] watchdog clearing stuck in_flight token (age ${Math.floor(ageMs / 60000)}min)`);
    await deleteSyncState(env, 'in_flight');
  }
}

export async function tailSync(env) {
  await watchdog(env);
  if (await readSyncState(env, 'in_flight')) {
    console.log('[sync] in_flight set, skipping tail tick');
    return;
  }
  await writeSyncState(env, 'in_flight', 'true');
  const t0 = Date.now();
  try {
    const cursor = (await readSyncState(env, 'last_tail_sync_at'))
      ?? new Date(Date.now() - 60 * 60_000).toISOString();
    // fetchCandidatesUpdatedSince returns { ids, suggestedCursor }. Use
    // suggestedCursor verbatim — it's `min(returned)` when capped (so the
    // dropped edge rows are picked up next tick) and `max(returned)` otherwise.
    // Do NOT recompute the cursor from per-candidate `last_updated`; that
    // skips dropped rows and silently loses updates when HARD_CAP fires.
    const { ids, suggestedCursor } = await rfClient.fetchCandidatesUpdatedSince(env, cursor);
    let upserted = 0;

    for (const batch of chunks(ids, 25)) {
      const candidates = await Promise.all(batch.map(id => rfClient.fetchCandidate(env, id)));
      await writeCandidatesAndLinks(env, candidates);
      upserted += candidates.length;
    }

    // Refresh jobs every tick. New jobs and open-status flips don't otherwise
    // surface until the next manual full rebuild — `/job/list` is only a few
    // hundred rows so the cost is negligible compared to the candidate fetch.
    const allJobs = await rfClient.fetchAllJobs(env);
    await writeJobs(env, allJobs);

    await writeSyncState(env, 'last_tail_sync_at', suggestedCursor);
    await writeSyncState(env, 'last_tail_sync_count', String(upserted));
    console.log(`[sync] tail done — ${upserted} upserted in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[sync] tail failed: ${err.message}`);
  } finally {
    await deleteSyncState(env, 'in_flight');
  }
}

/**
 * Additive-only tail sync (spec rev 5).
 *
 * Routes to three INSERT-OR-IGNORE subtasks via Promise.allSettled — one
 * subtask failing doesn't block the others. Each subtask owns its own
 * cursor / error log / outer try/catch.
 *
 * Subtasks:
 *   - candidates: /candidate/search added_on > cursor -> writeCandidatesThin
 *   - jobs:       /job/list full re-scan + /job/pipeline for new jobs only
 *   - calls:      per-consultant /v2/call started_after = MAX(date_started_ms) - 6h
 */
export async function tailSyncThin(env) {
  const results = await Promise.allSettled([
    tailSyncCandidatesThin(env),
    tailSyncJobsThin(env),
    tailSyncCallsThin(env),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error({
        message: `[sync] unexpected unhandled subtask rejection: ${r.reason?.message ?? r.reason}`,
        source: 'sync-worker',
        reason: r.reason?.message ?? String(r.reason),
      });
    }
  }
}

async function tailSyncCandidatesThin(env) {
  const t0 = Date.now();
  try {
    const cursor = (await readSyncState(env, 'last_candidates_added_cursor'))
      ?? new Date(Date.now() - ONE_DAY_MS).toISOString();
    const { rows, suggestedCursor, capped } = await rfClient.fetchCandidatesAddedSince(env, cursor);
    // TODO(hardening): wrap writeCandidatesThin in per-row try/catch if production
    // logs show frequent thrown rows from to*Row builders. For now, INSERT-OR-IGNORE
    // semantics mean the next tick re-fetches free if a bad row crashes mid-batch;
    // the cursor doesn't advance, so no data is lost.
    await writeCandidatesThin(env, rows);
    await writeSyncState(env, 'last_candidates_added_cursor', suggestedCursor);
    console.log({
      message: `[sync] candidates tick rows=${rows.length} capped=${capped} took=${Date.now() - t0}ms`,
      source: 'sync-worker', subtask: 'candidates',
      rows: rows.length, capped, durationMs: Date.now() - t0,
    });
  } catch (err) {
    console.error({
      message: `[sync] candidates tick failed: ${err.message}`,
      source: 'sync-worker', subtask: 'candidates',
      error: err.message, stack: err.stack,
    });
  }
}

async function tailSyncJobsThin(env) {
  const t0 = Date.now();
  try {
    const allJobs = await rfClient.fetchAllJobs(env);
    const knownIds = new Set(
      ((await env.RF_MCP_CACHE.prepare('SELECT id FROM jobs_v2').all()).results ?? [])
        .map(r => r.id)
    );
    const newJobs = allJobs.filter(j => !knownIds.has(j.id));
    const pipelineByJobId = new Map();
    for (const job of newJobs) {
      try {
        const pipeline = await rfClient.fetchJobPipeline(env, job.id);
        pipelineByJobId.set(job.id, pipeline?.summary ?? []);
      } catch (err) {
        console.warn({
          message: `[sync] /job/pipeline fetch failed job=${job.id}: ${err.message}`,
          source: 'sync-worker', subtask: 'jobs',
        });
      }
    }
    await writeJobsThin(env, allJobs, { pipelineByJobId });
    console.log({
      message: `[sync] jobs tick total=${allJobs.length} new=${newJobs.length} took=${Date.now() - t0}ms`,
      source: 'sync-worker', subtask: 'jobs',
      total: allJobs.length, new: newJobs.length, durationMs: Date.now() - t0,
    });
  } catch (err) {
    console.error({
      message: `[sync] jobs tick failed: ${err.message}`,
      source: 'sync-worker', subtask: 'jobs',
      error: err.message, stack: err.stack,
    });
  }
}

async function tailSyncCallsThin(env) {
  const t0 = Date.now();
  try {
    const consultants = await listConsultants(env);
    let totalRows = 0;
    for (const c of consultants) {
      try {
        const lastSeenRow = await env.RF_MCP_CACHE
          .prepare('SELECT MAX(date_started_ms) AS max FROM calls WHERE target_dialpad_id = ?')
          .bind(c.dialpadId).first();
        const lastSeenMs = (lastSeenRow?.max != null) ? lastSeenRow.max : (Date.now() - ONE_DAY_MS);
        const startedAfterMs = Math.max(0, lastSeenMs - SIX_HOURS_MS);
        const calls = await fetchCallsForConsultant(env, c.dialpadId, startedAfterMs);
        await writeCalls(env, calls);
        totalRows += calls.length;
      } catch (err) {
        console.error({
          message: `[sync] calls tick consultant=${c.dialpadId} failed: ${err.message}`,
          source: 'sync-worker', subtask: 'calls',
          consultantDialpadId: c.dialpadId, error: err.message,
        });
      }
    }
    console.log({
      message: `[sync] calls tick consultants=${consultants.length} rows=${totalRows} took=${Date.now() - t0}ms`,
      source: 'sync-worker', subtask: 'calls',
      consultants: consultants.length, rows: totalRows, durationMs: Date.now() - t0,
    });
  } catch (err) {
    console.error({
      message: `[sync] calls tick failed: ${err.message}`,
      source: 'sync-worker', subtask: 'calls',
      error: err.message, stack: err.stack,
    });
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await tailSync(env);          // legacy — writes old tables
      await tailSyncThin(env);      // new — writes _v2 + calls (additive-only INSERT-OR-IGNORE)
      if (env.PIPELINE_REBUILD_WORKFLOW?.create) {
        await env.PIPELINE_REBUILD_WORKFLOW.create({
          id: crypto.randomUUID(),
          params: { startedAt: new Date().toISOString() },
        });
      }
    })());
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/admin/')) return handleAdmin(request, env, ctx);
    return new Response('not found', { status: 404 });
  },
};

export { FullRebuildWorkflow } from './workflow.js';
export { PipelineRebuildWorkflow } from './pipeline-workflow.js';
