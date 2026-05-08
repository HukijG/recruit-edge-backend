import * as rfClient from './rf-list-client.js';
import { writeCandidatesAndLinks, writeJobs } from './d1-write.js';
import { readSyncState, writeSyncState, deleteSyncState } from './sync-state.js';

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await tailSync(env);
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
