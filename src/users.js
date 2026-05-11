/**
 * Team registry — D1-backed lookups, async.
 *
 * `env.USERS_DB.users` is the SOURCE OF TRUTH for the team registry; this
 * module is a read-through cache over it. Per CLAUDE.md's "Single sources of
 * truth" rule, all consultant lookups (cold-call attribution, calendar
 * Joel-only logic, extension consultantFirstName resolution, MCP
 * consultantEmail resolution) read from here.
 *
 * `USERS_DB` is owned by the MAIN worker — it is NOT the sync-worker's
 * `RF_MCP_CACHE` D1 (which holds candidates/jobs and follows the "only the
 * sync worker writes D1" invariant). USERS_DB writes happen through migrations
 * applied by the operator; this module never writes.
 *
 * Identity records are keyed by lowercase email (the `email` PK column has a
 * `CHECK (email = LOWER(email))` constraint). Every public function takes
 * `env` as its first argument and returns a Promise (call sites must `await`).
 *
 * Caching:
 *   - Module-level cache populated on first call after Worker boot via a
 *     single bulk `SELECT * FROM users`.
 *   - Concurrent first-call requests share the same in-flight Promise so
 *     they collapse to one D1 read (avoids a thundering-herd on cold start).
 *   - The cache is invalidated only on Worker restart. Updating D1 directly
 *     (e.g. `wrangler d1 execute --remote ... INSERT`) will NOT show up in
 *     the running isolate; deploy a new Worker version (or wait for a cold
 *     start) to pick up changes. This is acceptable: team membership changes
 *     happen quarterly, not continuously.
 *
 * Public function names and order match the previous in-memory module so
 * grep-driven call-site sweeps stay clean.
 */

let cache = null;
let inflight = null;

function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().toLowerCase();
  return trimmed || null;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function parseAliases(raw, email) {
  // Defensive: a malformed `aliases` JSON value should NOT take the entire
  // module offline. Log it loudly (so the bad row is fixable) and treat the
  // record as having no aliases. Schema doesn't validate JSON shape — only
  // TEXT vs NULL — so a hand-edited row could legitimately end up here.
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error({ source: 'users', message: 'malformed aliases JSON', email, error: err.message });
    return null;
  }
}

function rowToRecord(row) {
  return {
    email: row.email,
    rfUserId: row.rf_user_id,
    dialpadId: row.dialpad_id,
    firstName: row.first_name,
    calendarMode: row.calendar_mode,
    aliases: parseAliases(row.aliases, row.email),
  };
}

async function loadCache(env) {
  const { results } = await env.USERS_DB
    .prepare('SELECT email, rf_user_id, dialpad_id, first_name, calendar_mode, aliases FROM users')
    .all();
  const records = (results ?? []).map(rowToRecord);

  // byFirstName: aliases are inserted FIRST, then primary firstNames second,
  // so a primary firstName always wins over a colliding alias on another
  // record (Map.set replaces). This is the correct semantics: if anyone is
  // ever named "Bob" as their primary, their record beats Bob's alias.
  const byFirstName = new Map();
  for (const r of records) {
    if (Array.isArray(r.aliases)) {
      for (const a of r.aliases) byFirstName.set(a.toLowerCase(), r);
    }
  }
  for (const r of records) byFirstName.set(r.firstName.toLowerCase(), r);

  return {
    byEmail: new Map(records.map((r) => [r.email, r])),
    byDialpadId: new Map(records.map((r) => [r.dialpadId, r])),
    byRFUserId: new Map(records.map((r) => [r.rfUserId, r])),
    byFirstName,
  };
}

async function ensureCache(env) {
  if (cache) return cache;
  if (!env?.USERS_DB) throw new Error('USERS_DB binding missing');
  // Memoize the in-flight Promise so concurrent first-callers share one read.
  if (!inflight) {
    inflight = loadCache(env)
      .then((c) => { cache = c; return c; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export async function getUserByEmail(env, email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  const c = await ensureCache(env);
  return c.byEmail.get(key) ?? null;
}

export async function getUserByFirstName(env, firstName) {
  const key = normalizeName(firstName);
  if (!key) return null;
  const c = await ensureCache(env);
  return c.byFirstName.get(key) ?? null;
}

export async function getUserByDialpadId(env, dialpadId) {
  if (dialpadId === null || dialpadId === undefined) return null;
  const key = String(dialpadId);
  const c = await ensureCache(env);
  return c.byDialpadId.get(key) ?? null;
}

export async function getUserByRFUserId(env, rfUserId) {
  if (rfUserId === null || rfUserId === undefined) return null;
  const c = await ensureCache(env);
  return c.byRFUserId.get(rfUserId) ?? null;
}

export async function resolveRFUserId(env, firstName) {
  return (await getUserByFirstName(env, firstName))?.rfUserId ?? null;
}

export async function getRFUserIdByDialpadId(env, dialpadId) {
  return (await getUserByDialpadId(env, dialpadId))?.rfUserId ?? null;
}

export async function isMonitoredDialpadUser(env, dialpadId) {
  return (await getUserByDialpadId(env, dialpadId)) !== null;
}

/**
 * Test-only: clear the module-level cache so the next call re-reads D1.
 * Called from `beforeEach` in the unit tests; do not use in production code.
 */
export function _resetCacheForTests() {
  cache = null;
  inflight = null;
}
