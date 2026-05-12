/**
 * Test helper: apply the D1 schema to the main worker's test DB.
 *
 * The main worker doesn't ship its own migrations — it shares the cache
 * schema with cache-worker, which is the sole writer.  Importing the SQL via
 * Vite's `?raw` query keeps the FS read at bundle time so the test runs
 * inside the Workers sandbox without needing node:fs at runtime.
 *
 * Mirrors `cache-worker/test/helpers/migrate.js`, but takes the worker `env`
 * (rather than a raw D1 handle) so call-sites read naturally as
 * `await applyMigration(env)`.
 */

import init from '../../cache-worker/migrations/0001_init.sql?raw';
import jobPipelines from '../../cache-worker/migrations/0002_job_pipelines.sql?raw';
import v2Tables from '../../cache-worker/migrations/0003_v2_tables.sql?raw';

const SCHEMA = [init, jobPipelines, v2Tables].join('\n');

/**
 * Apply the schema to env.RF_MCP_CACHE.  Drops existing user tables first so
 * it's safe to call from beforeEach (indexes drop with their parent table).
 *
 * @param {*} env - Worker env containing the RF_MCP_CACHE D1 binding.
 */
export async function applyMigration(env) {
  const db = env.RF_MCP_CACHE;

  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table'" +
      " AND name NOT LIKE 'sqlite_%'" +
      " AND name NOT LIKE '_cf_%'" +
      " AND name != 'd1_migrations'"
    )
    .all();
  for (const { name } of results) {
    await db.prepare(`DROP TABLE IF EXISTS ${name}`).run();
  }

  // Split on `;` followed by optional whitespace + newline. Matches the
  // statement-per-line style of 0001_init.sql.
  const stmts = SCHEMA.split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    await db.prepare(stmt).run();
  }
}
