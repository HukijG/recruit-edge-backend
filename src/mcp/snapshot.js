import { prepareTarget } from './fuzzy.js';

const G = globalThis;
const KEY = '__rfMcpFuzzySnapshot';

export function resetSnapshot() {
  G[KEY] = null;
}

async function readVersion(env) {
  const row = await env.RF_MCP_CACHE
    .prepare("SELECT value FROM sync_state WHERE key = 'last_tail_sync_at'")
    .first();
  return row?.value ?? null;
}

async function loadRows(env) {
  const { results } = await env.RF_MCP_CACHE
    .prepare('SELECT id, name, last_activity_at FROM candidates')
    .all();
  return results.map(r => ({
    id: r.id,
    name: r.name,
    prepared: prepareTarget(r.name ?? ''),
    last_activity_at: r.last_activity_at,
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
