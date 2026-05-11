import { prepareTarget } from './fuzzy.js';

const G = globalThis;
const KEY = '__rfMcpFuzzySnapshot';

export function resetSnapshot() {
  G[KEY] = null;
}

async function readVersion(env) {
  // Use the new cron's cursor as the cache-version key. When the cron writes
  // new candidates, this advances; the next snapshot read picks up the change.
  // Falls back to the legacy key during the dual-write phase if the new key
  // hasn't been populated yet.
  const row = await env.RF_MCP_CACHE
    .prepare("SELECT value FROM sync_state WHERE key = 'last_candidates_added_cursor'")
    .first();
  if (row?.value) return row.value;
  const legacy = await env.RF_MCP_CACHE
    .prepare("SELECT value FROM sync_state WHERE key = 'last_tail_sync_at'")
    .first();
  return legacy?.value ?? null;
}

async function loadRows(env) {
  const { results } = await env.RF_MCP_CACHE
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
  const version = await readVersion(env);
  const cached = G[KEY];
  if (cached && cached.dataVersion === version) return cached;
  const rows = await loadRows(env);
  G[KEY] = { rows, dataVersion: version, loadedAt: Date.now() };
  return G[KEY];
}
