/**
 * Read-only enumeration of USERS_DB.users from cache-worker.
 *
 * USERS_DB is owned by the main worker (per CLAUDE.md "USERS_DB ... is owned
 * by the main worker"). Cache-worker binds it read-only here so cron tail-sync
 * can fan out per consultant.
 *
 * NB: column is `dialpad_id`, NOT `dialpad_user_id` (verified spec rev 5 CC-2).
 */
export async function listConsultants(env) {
  if (!env?.USERS_DB) throw new Error('USERS_DB binding missing on cache-worker');
  const { results } = await env.USERS_DB
    .prepare('SELECT email, rf_user_id, dialpad_id, first_name FROM users')
    .all();
  return (results ?? []).map(r => ({
    email: r.email,
    dialpadId: r.dialpad_id,
    rfUserId: r.rf_user_id,
    firstName: r.first_name,
  }));
}
