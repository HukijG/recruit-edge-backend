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

  if (url.pathname === '/admin/cache-rebuild' && request.method === 'POST') {
    const table = url.searchParams.get('table');  // 'candidates' | 'jobs' | 'calls'
    const since = url.searchParams.get('since');  // optional ISO date (calls only)
    if (!['candidates', 'jobs', 'calls'].includes(table)) {
      return Response.json({ ok: false, error: `table must be one of candidates|jobs|calls` }, { status: 400 });
    }
    if (since && !Number.isFinite(Date.parse(since))) {
      return Response.json({ ok: false, error: `since must be a valid ISO date` }, { status: 400 });
    }
    if (!env.CACHE_SEED_WORKFLOW?.create) {
      return Response.json({ ok: false, error: 'CACHE_SEED_WORKFLOW binding missing' }, { status: 500 });
    }
    const instance = await env.CACHE_SEED_WORKFLOW.create({
      id: crypto.randomUUID(),
      params: { table, since: since || undefined },
    });
    return Response.json({ ok: true, workflow_id: instance.id }, { status: 202 });
  }

  return new Response('not found', { status: 404 });
}

const WATCHDOG_HOURS = 6;
const WATCHDOG_MS = WATCHDOG_HOURS * 3600_000;
const SIX_HOURS_MS = 6 * 3600_000;
const ONE_DAY_MS = 24 * 3600_000;
// Two-year cold-start lookback. Mirrors the admin seed default
// (workflow.js `runCacheSeed` calls path → 2y) so a fresh deployment without
// a prior seed doesn't silently lose anything older than 1 day.
const TWO_YEARS_MS = 2 * 365 * 24 * 3600_000;

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

/**
 * Per-subtask in-flight watchdog for the thin tail-sync subtasks.
 * Mirrors the legacy `watchdog(env)` but takes the in-flight key + a
 * "subtask-specific last completion timestamp" key — clearing the lease only
 * when the lease has been held longer than WATCHDOG_HOURS without progress.
 *
 * @param {object} env
 * @param {string} inFlightKey   - sync_state key holding the lease token
 * @param {string} lastDoneKey   - sync_state key holding the last successful completion ISO time
 * @param {string} subtask       - short id for log lines
 */
async function watchdogSubtask(env, inFlightKey, lastDoneKey, subtask) {
  const inFlight = await readSyncState(env, inFlightKey);
  if (!inFlight) return;
  // The lease itself stores the ISO time it was claimed. If `lastDoneKey`
  // has been written more recently (i.e. a prior tick succeeded after the
  // stuck lease was set), the watchdog falls back to that newer timestamp.
  const leaseClaimed = inFlight;
  const lastDone = await readSyncState(env, lastDoneKey);
  // Choose the more recent of (leaseClaimed, lastDone) for age comparison.
  // Lease value defaults to a parseable ISO string from watchdog claims; on
  // unparseable garbage the lease is treated as stuck and cleared.
  const leaseMs = Date.parse(leaseClaimed);
  const lastDoneMs = lastDone ? Date.parse(lastDone) : NaN;
  const referenceMs = Math.max(
    Number.isFinite(leaseMs) ? leaseMs : 0,
    Number.isFinite(lastDoneMs) ? lastDoneMs : 0,
  );
  if (referenceMs === 0) {
    // Lease has no meaningful timestamp (legacy boolean payload, e.g. "true")
    // AND there's no completion record either — clear conservatively so we
    // don't permanently deadlock the subtask.
    console.warn({
      message: `[sync] watchdog clearing untimed in_flight token subtask=${subtask}`,
      source: 'sync-worker', subtask, op: 'watchdog_clear_untimed',
    });
    await deleteSyncState(env, inFlightKey);
    return;
  }
  const ageMs = Date.now() - referenceMs;
  if (ageMs > WATCHDOG_MS) {
    console.warn({
      message: `[sync] watchdog clearing stuck in_flight token subtask=${subtask} (age ${Math.floor(ageMs / 60000)}min)`,
      source: 'sync-worker', subtask, op: 'watchdog_clear',
      ageMinutes: Math.floor(ageMs / 60000),
    });
    await deleteSyncState(env, inFlightKey);
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
  // Watchdog first: if a prior tick crashed without releasing the lease,
  // clear it after WATCHDOG_HOURS so we don't block forever.
  await watchdogSubtask(env, 'thin_candidates_in_flight', 'thin_candidates_done_at', 'candidates');
  if (await readSyncState(env, 'thin_candidates_in_flight')) {
    console.log({
      message: '[sync] candidates subtask already in flight, skipping',
      source: 'sync-worker', subtask: 'candidates', op: 'skip_in_flight',
    });
    return;
  }
  await writeSyncState(env, 'thin_candidates_in_flight', new Date().toISOString());
  try {
    // Cold-start default: 2-year lookback (mirrors `runCacheSeed`'s seed
    // default). The previous 1-day default meant a fresh deployment without
    // a prior admin seed silently lost anything older than a day.
    const cursor = (await readSyncState(env, 'last_candidates_added_cursor'))
      ?? new Date(Date.now() - TWO_YEARS_MS).toISOString();
    const { rows, suggestedCursor, capped } = await rfClient.fetchCandidatesAddedSince(env, cursor);
    // writeCandidatesThin is per-row resilient: a single malformed RF row
    // emits a structured `skip_row` log line and is omitted from the batch;
    // the rest of the page still lands. The cursor still advances because
    // RF returned a valid page.
    await writeCandidatesThin(env, rows);
    await writeSyncState(env, 'last_candidates_added_cursor', suggestedCursor);
    await writeSyncState(env, 'thin_candidates_done_at', new Date().toISOString());
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
  } finally {
    await deleteSyncState(env, 'thin_candidates_in_flight');
  }
}

async function tailSyncJobsThin(env) {
  const t0 = Date.now();
  await watchdogSubtask(env, 'thin_jobs_in_flight', 'thin_jobs_done_at', 'jobs');
  if (await readSyncState(env, 'thin_jobs_in_flight')) {
    console.log({
      message: '[sync] jobs subtask already in flight, skipping',
      source: 'sync-worker', subtask: 'jobs', op: 'skip_in_flight',
    });
    return;
  }
  await writeSyncState(env, 'thin_jobs_in_flight', new Date().toISOString());
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
    await writeSyncState(env, 'thin_jobs_done_at', new Date().toISOString());
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
  } finally {
    await deleteSyncState(env, 'thin_jobs_in_flight');
  }
}

async function tailSyncCallsThin(env) {
  const t0 = Date.now();
  await watchdogSubtask(env, 'thin_calls_in_flight', 'thin_calls_done_at', 'calls');
  if (await readSyncState(env, 'thin_calls_in_flight')) {
    console.log({
      message: '[sync] calls subtask already in flight, skipping',
      source: 'sync-worker', subtask: 'calls', op: 'skip_in_flight',
    });
    return;
  }
  await writeSyncState(env, 'thin_calls_in_flight', new Date().toISOString());
  try {
    const consultants = await listConsultants(env);
    let totalRows = 0;
    for (const c of consultants) {
      try {
        const lastSeenRow = await env.RF_MCP_CACHE
          .prepare('SELECT MAX(date_started_ms) AS max FROM calls WHERE target_dialpad_id = ?')
          .bind(c.dialpadId).first();
        // Cold-start default: 2-year lookback per consultant. Decision: the
        // seed default is 2 years (`runCacheSeed`), and the operating envelope
        // (Dialpad call history across consultants) does fit a 2-year window
        // without overwhelming the MAX_PAGES=25 cap (call volume per consultant
        // is at most a few thousand per year). Picking the seed-symmetric
        // default avoids the same "fresh deploy silently loses old calls" trap
        // as the candidates cursor (#5).
        const lastSeenMs = (lastSeenRow?.max != null) ? lastSeenRow.max : (Date.now() - TWO_YEARS_MS);
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
    await writeSyncState(env, 'thin_calls_done_at', new Date().toISOString());
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
  } finally {
    await deleteSyncState(env, 'thin_calls_in_flight');
  }
}

async function handleInternal(request, env, ctx) {
  // Service-binding-only endpoint. Defense-in-depth: even though the
  // workers_dev subdomain is disabled, require a shared secret in case
  // the route surface ever expands (Workers Routes / custom domain etc.).
  const token = request.headers.get('X-Internal-Token');
  if (!env.INTERNAL_SECRET || !token || !timingSafeEqual(token, env.INTERNAL_SECRET)) {
    return Response.json({ ok: false, error: 'auth' }, { status: 401 });
  }

  const url = new URL(request.url);

  if (url.pathname === '/internal/calls/upsert') {
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!payload?.call_id || !payload?.target?.id || payload?.date_started == null) {
      return Response.json({ ok: false, error: 'missing required fields (call_id, target.id, date_started)' }, { status: 400 });
    }
    if (!Number.isFinite(Number(payload.date_started))) {
      return Response.json({ ok: false, error: 'date_started must be a finite number (UTC ms)' }, { status: 400 });
    }
    try {
      await writeCalls(env, [payload]);
    } catch (err) {
      console.error({
        message: `[internal] calls upsert failed call_id=${payload.call_id}: ${err.message}`,
        source: 'sync-worker', endpoint: 'internal-calls-upsert',
        callId: payload.call_id, error: err.message,
      });
      return Response.json({ ok: false, error: 'write failed' }, { status: 500 });
    }
    return Response.json({ ok: true });
  }

  return new Response('not found', { status: 404 });
}

/**
 * Guards the additive INSERT-OR-IGNORE tail-sync path behind a runtime flag
 * so the operator can flip the dual-write phase on/off without a deploy.
 * Default false — the new cron is OFF until the operator sets the var.
 *
 * No LaunchDarkly SDK integration exists in sync-worker yet. When LD plumbing
 * is added, replace this env-var check with a proper LD client call
 * (no per-consultant context needed for a cron — use a generic worker context).
 */
async function getCacheCronAdditiveFlag(env) {
  return env.CRON_THIN_ENABLED === 'true' || env.CRON_THIN_ENABLED === '1';
}

/**
 * Guards the LEGACY tail-sync path behind a runtime flag.
 *
 * Background: project memory `project_sync_cron_disabled.md` notes that the
 * legacy writers (`writeJobs` / `writeJobPipeline` / `writeCandidatesAndLinks`)
 * INSERT-OR-REPLACE on every tick regardless of whether anything actually
 * changed — driving ~1M D1 writes/day with zero active consumers. They do not
 * gate on unchanged rows. Until step 6 of the cutover deletes the legacy code
 * entirely, gate it OFF at runtime via this flag.
 *
 * Default false. To enable temporarily during cutover diagnostics:
 *   wrangler secret put CRON_LEGACY_ENABLED  # value "true" or "1"
 * (or edit wrangler vars + redeploy).
 *
 * Same value-shape as `getCacheCronAdditiveFlag` — accept "true" or "1".
 */
async function getCacheCronLegacyFlag(env) {
  return env.CRON_LEGACY_ENABLED === 'true' || env.CRON_LEGACY_ENABLED === '1';
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // Legacy tailSync is gated OFF by default — its writers don't skip
      // unchanged rows and drove the D1 write-storm that disabled cron
      // (2026-05-10). Re-enabled only by explicit operator opt-in.
      // After cutover step 6 the legacy code is dropped and this gate
      // becomes redundant. Until then, keep it OFF.
      if (await getCacheCronLegacyFlag(env)) {
        await tailSync(env);
      } else {
        console.log({
          message: '[sync] legacy tailSync skipped (CRON_LEGACY_ENABLED=false)',
          source: 'sync-worker', op: 'skip_legacy_tail_sync',
        });
      }
      if (await getCacheCronAdditiveFlag(env)) {
        await tailSyncThin(env);    // new — writes _v2 + calls (additive-only INSERT-OR-IGNORE)
      }
      // PIPELINE_REBUILD_WORKFLOW intentionally NOT spawned. The
      // `job_pipelines` table it writes is dropped at cutover step 6 and
      // there are no active consumers of pipeline cache reads. The workflow
      // class is still exported (last-import compat for the running deploy)
      // but never instantiated from cron.
    })());
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/admin/')) return handleAdmin(request, env, ctx);
    if (url.pathname.startsWith('/internal/')) return handleInternal(request, env, ctx);
    return new Response('not found', { status: 404 });
  },
};

export { FullRebuildWorkflow } from './workflow.js';
export { CacheSeedWorkflow } from './workflow.js';
export { PipelineRebuildWorkflow } from './pipeline-workflow.js';
