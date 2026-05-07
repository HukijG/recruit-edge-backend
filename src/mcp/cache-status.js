import { jsonResponse } from './router.js';
import { countTable } from './d1-read.js';

async function readState(env, key) {
  const r = await env.RF_MCP_CACHE
    .prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first();
  return r?.value ?? null;
}

export async function handleCacheStatus({ env }) {
  const [candidates_count, jobs_count, last_tail_sync_at, last_full_rebuild_at, in_flight, last_tail_sync_count] =
    await Promise.all([
      countTable(env, 'candidates'),
      countTable(env, 'jobs'),
      readState(env, 'last_tail_sync_at'),
      readState(env, 'last_full_rebuild_at'),
      readState(env, 'in_flight'),
      readState(env, 'last_tail_sync_count'),
    ]);
  const minutes_since_last_sync = last_tail_sync_at
    ? Math.floor((Date.now() - Date.parse(last_tail_sync_at)) / 60000)
    : null;
  return jsonResponse(200, {
    candidates_count, jobs_count,
    last_tail_sync_at,
    last_tail_sync_count: last_tail_sync_count ? Number(last_tail_sync_count) : null,
    minutes_since_last_sync,
    last_full_rebuild_at,
    in_flight,
  });
}
