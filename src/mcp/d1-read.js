/**
 * D1 read helpers for the MCP middleware surface.
 *
 * The sync-worker is the sole writer to the rf-mcp-cache D1 database; this
 * worker is read-only.  All reads are wrapped in a Sessions-API session so
 * D1 can route to the closest replica while preserving read-your-writes
 * semantics for callers that thread a bookmark through.
 *
 * In production `withSession()` is always available on the D1 binding.  In
 * miniflare's local D1 implementation it isn't, so `session()` falls back to
 * the raw binding — behaviour is identical for our read-only queries because
 * miniflare runs a single SQLite instance with no replicas to route between.
 */

/**
 * Wrap a D1 query in a Sessions-API session for replica routing.
 * Falls back to the raw binding if `withSession` isn't implemented (miniflare).
 *
 * @param {*} env - Worker env containing the RF_MCP_CACHE D1 binding.
 * @param {string} [bookmark] - Sessions-API bookmark; defaults to first-unconstrained.
 */
export function session(env, bookmark = 'first-unconstrained') {
  const db = env.RF_MCP_CACHE;
  if (typeof db.withSession === 'function') {
    return db.withSession(bookmark);
  }
  return db;
}

export async function getCandidateById(env, id) {
  const row = await session(env)
    .prepare('SELECT body FROM candidates WHERE id = ?')
    .bind(id)
    .first();
  return row ? JSON.parse(row.body) : null;
}

export async function getCandidateByEmail(env, email) {
  const row = await session(env)
    .prepare('SELECT body FROM candidates WHERE primary_email = ?')
    .bind(email.toLowerCase())
    .first();
  return row ? JSON.parse(row.body) : null;
}

export async function getCandidateByLinkedIn(env, slug) {
  const row = await session(env)
    .prepare('SELECT body FROM candidates WHERE linkedin_profile = ?')
    .bind(slug.toLowerCase())
    .first();
  return row ? JSON.parse(row.body) : null;
}

export async function countTable(env, table) {
  const row = await session(env)
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first();
  return row?.n ?? 0;
}
