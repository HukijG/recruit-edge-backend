import { prepareTarget } from './fuzzy.js';
import { session } from './d1-read.js';

const G = globalThis;
const KEY = '__rfMcpFuzzySnapshot';

export function resetSnapshot() {
  G[KEY] = null;
}

async function readVersion(db) {
  // Use the new cron's cursor as the cache-version key. When the cron writes
  // new candidates, this advances; the next snapshot read picks up the change.
  // Falls back to the legacy key during the dual-write phase if the new key
  // hasn't been populated yet.
  const row = await db
    .prepare("SELECT value FROM sync_state WHERE key = 'last_candidates_added_cursor'")
    .first();
  if (row?.value) return row.value;
  // TODO(task-30): remove this legacy-cursor fallback once cutover step 6 + Task 30
  // drop the legacy code paths. Until then, this fallback prevents a snapshot black-hole
  // during the dual-write rollout window (between sync-worker dual-write deploy and the
  // new cron's first run).
  const legacy = await db
    .prepare("SELECT value FROM sync_state WHERE key = 'last_tail_sync_at'")
    .first();
  return legacy?.value ?? null;
}

async function loadRows(db) {
  const { results } = await db
    .prepare('SELECT id, name, linkedin_profile, added_time_ms FROM candidates_v2')
    .all();
  return results.map(r => ({
    id: r.id,
    name: r.name,
    prepared: prepareTarget(r.name ?? ''),
    linkedin_profile: r.linkedin_profile,
    added_time_ms: r.added_time_ms,
  }));
}

export async function getSnapshot(env) {
  // One D1 Sessions handle per refresh: the version-cursor read and the row
  // load share the same bookmark so we get read-after-write consistency
  // against the sync-worker's latest commit.
  const db = session(env);
  const version = await readVersion(db);
  const cached = G[KEY];
  if (cached && cached.dataVersion === version) return cached;
  const rows = await loadRows(db);
  G[KEY] = { rows, dataVersion: version, loadedAt: Date.now() };
  return G[KEY];
}
