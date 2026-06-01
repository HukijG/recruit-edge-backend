/**
 * Read-only identity gate over the team registry (USERS_DB.users).
 *
 * USERS_DB is owned by the MAIN worker (per ../CLAUDE.md "USERS_DB ... is owned
 * by the main worker"). This worker binds it READ-ONLY (no migrations_dir in
 * wrangler.music.jsonc) so the JWT auth branch can resolve "is this verified
 * email a registered teammate?". It NEVER writes.
 *
 * The function body is modeled on the MAIN worker src/users.js getUserByEmail
 * (single-row email lookup, normalizeEmail to lowercase, env-first, returns
 * {email, firstName}|null). It is NOT modeled on cache-worker's
 * `listConsultants`, which returns an ARRAY of ALL users (SELECT email,
 * rf_user_id, dialpad_id, first_name ... no WHERE) — that is the wrong shape for
 * an identity gate. cache-worker/src/users-d1-read.js is mirrored ONLY as the
 * read-only-USERS_DB binding precedent.
 *
 * The main worker's module-level cache (single bulk SELECT * memoized until cold
 * start) is DROPPED ON PURPOSE: a per-request single-row D1 read is correct for a
 * low-volume music remote and avoids the documented stale-until-cold-start
 * behavior. Identity records are keyed by lowercase email (the `email` PK column
 * has a CHECK (email = LOWER(email)) constraint); `first_name` is NOT NULL.
 */

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

/**
 * @param {{ USERS_DB: D1Database }} env
 * @param {string} email
 * @returns {Promise<{ email: string, firstName: string } | null>}
 */
export async function getUserByEmail(env, email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  if (!env?.USERS_DB) throw new Error('USERS_DB binding missing on music-worker');
  const row = await env.USERS_DB
    .prepare('SELECT email, first_name FROM users WHERE email = ?')
    .bind(key)
    .first();
  if (!row) return null;
  return { email: row.email, firstName: row.first_name };
}
