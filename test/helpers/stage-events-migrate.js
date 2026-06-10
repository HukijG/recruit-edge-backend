/**
 * Test helper: apply the stage-events schema to env.STAGE_EVENTS.
 * Mirrors test/helpers/users-migrate.js but targets the STAGE_EVENTS D1.
 *
 * Importing SQL via Vite's `?raw` query keeps the FS read at bundle time so
 * the test runs inside the Workers sandbox without needing node:fs at runtime.
 */

import schema from '../../migrations-stage-events/0001_create_stage_events.sql?raw';

/**
 * Apply the stage-events schema to env.STAGE_EVENTS. Drops the table first
 * (indexes drop with their parent table in SQLite) so it is safe to call from
 * beforeEach.
 *
 * @param {*} env - Worker env containing the STAGE_EVENTS D1 binding.
 */
export async function applyStageEventsMigration(env) {
  const db = env.STAGE_EVENTS;
  await db.prepare('DROP TABLE IF EXISTS stage_events').run();

  const stmts = schema
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    // Drop comment-only chunks — they would error as "no SQL statements" on prepare.
    .filter((s) => s.split('\n').some((line) => line.trim() && !line.trim().startsWith('--')));
  for (const stmt of stmts) {
    await db.prepare(stmt).run();
  }
}
