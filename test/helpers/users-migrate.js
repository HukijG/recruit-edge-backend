/**
 * Test helper: apply the users schema + seed to env.USERS_DB.
 * Mirrors test/helpers/d1-migrate.js but targets USERS_DB.
 *
 * Importing SQL via Vite's `?raw` query keeps the FS read at bundle time so
 * the test runs inside the Workers sandbox without needing node:fs at runtime.
 */

import schema from '../../migrations/0001_create_users.sql?raw';
import seedRaw from '../../migrations/0002_seed_users.sql?raw';
import smsTemplatesSchema from '../../migrations/0003_create_sms_templates.sql?raw';

// TEST_EMAILS substitutes <TODO_EMAIL_*> placeholders so the test seed is
// self-contained and passes the CHECK (email LIKE '%@%.%') constraint.
//
// NOTE: if a future seed migration adds a new teammate with a new placeholder,
// this map MUST be updated too — an unresolved placeholder will trip the email
// CHECK at apply-time, which is intentional (forces the helper to stay in sync).
const TEST_EMAILS = {
  '<TODO_EMAIL_JOEL>':   'joel@test.local',
  '<TODO_EMAIL_ALICE>':  'user2@test.local',
  '<TODO_EMAIL_BOB>': 'user5@test.local',
  '<TODO_EMAIL_CAROL>':  'user3@test.local',
  '<TODO_EMAIL_DAVE>':    'user1@test.local',
  '<TODO_EMAIL_ERIN>':   'user4@test.local',
};

const seed = Object.entries(TEST_EMAILS).reduce(
  (sql, [token, email]) => sql.replaceAll(token, email),
  seedRaw,
);

const SCHEMA = [schema, seed, smsTemplatesSchema].join('\n');

/**
 * Apply the users schema + seed to env.USERS_DB.  Drops the users table first
 * so it is safe to call from beforeEach (indexes drop with their parent table
 * in SQLite).
 *
 * The SQL splitter uses /;\s*\n/ rather than a bare ';' split so it is not
 * fooled by semicolons embedded inside string literals (e.g. VALUES('a;b')).
 * Today's migrations have no such literals — confirmed by inspection — but the
 * pattern is worth keeping correct as migrations grow.
 *
 * @param {*} env - Worker env containing the USERS_DB D1 binding.
 */
export async function applyUsersMigration(env) {
  const db = env.USERS_DB;

  // Drop tables this helper recreates (also drops their indexes in SQLite).
  await db.prepare('DROP TABLE IF EXISTS users').run();
  await db.prepare('DROP TABLE IF EXISTS sms_templates').run();

  const stmts = SCHEMA.split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    await db.prepare(stmt).run();
  }
}
