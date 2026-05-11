import { jsonResponse } from './router.js';
import { countTable, session, readSyncState } from './d1-read.js';

/**
 * Wrapper around `countTable` that returns null instead of throwing when the
 * table doesn't exist. Used so post-cutover-step-6 (legacy tables dropped) the
 * status endpoint still works — the operator sees `null` for the removed
 * counts rather than a 500.
 */
async function safeCount(env, table) {
  try {
    return await countTable(env, table);
  } catch {
    return null;
  }
}

/**
 * GET /mcp/cache-status — operator diagnostic for cache freshness.
 *
 * Reports counts and sync-state cursors for BOTH the legacy and the v2 thin
 * tables during the cutover window. Once `0004_drop_legacy.sql` is applied
 * (cutover step 6), the legacy counts surface as `null` (via the safeCount
 * try/catch) and the v2 counts are the authoritative numbers.
 *
 * The v2 cursor (`last_candidates_added_cursor`) reflects the
 * additive-only cron's progress through `added_on`-ordered RF candidates.
 */
export async function handleCacheStatus({ env }) {
  const [
    candidates_count, jobs_count,
    candidates_v2_count, jobs_v2_count, calls_count,
    last_tail_sync_at, last_full_rebuild_at, in_flight,
    last_tail_sync_count, last_candidates_added_cursor,
  ] = await Promise.all([
    safeCount(env, 'candidates'),
    safeCount(env, 'jobs'),
    safeCount(env, 'candidates_v2'),
    safeCount(env, 'jobs_v2'),
    safeCount(env, 'calls'),
    readSyncState(env, 'last_tail_sync_at'),
    readSyncState(env, 'last_full_rebuild_at'),
    readSyncState(env, 'in_flight'),
    readSyncState(env, 'last_tail_sync_count'),
    readSyncState(env, 'last_candidates_added_cursor'),
  ]);
  const minutes_since_last_sync = last_tail_sync_at
    ? Math.floor((Date.now() - Date.parse(last_tail_sync_at)) / 60000)
    : null;
  return jsonResponse(200, {
    ok: true,
    // Legacy counts (null after cutover step 6).
    candidates_count, jobs_count,
    // V2 (thin) counts — authoritative post-cutover.
    candidates_v2_count, jobs_v2_count, calls_count,
    last_tail_sync_at,
    last_tail_sync_count: last_tail_sync_count ? Number(last_tail_sync_count) : null,
    minutes_since_last_sync,
    last_full_rebuild_at,
    last_candidates_added_cursor,
    in_flight,
  });
}
