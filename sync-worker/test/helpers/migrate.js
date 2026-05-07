/**
 * Test helper: apply all migrations to the test D1 database.
 *
 * Imports each migration file as a raw string via Vite's `?raw` query so the
 * file-system read happens at bundle time (Node.js), not at runtime inside the
 * Workers sandbox (which only partially implements node:fs).  Adding a new
 * migration file requires adding a corresponding `?raw` import here — but the
 * schema itself (table/column definitions) never needs to be duplicated.
 *
 * Indexes are dropped automatically when their parent table is dropped, so
 * only tables need to be discovered and dropped.
 *
 * Uses db.prepare().run() for each statement so the helper works correctly
 * inside the Workers runtime (exec() has quirks with multi-line statements).
 */

import init from '../../migrations/0001_init.sql?raw';

// Concatenate all migration files in order. Add new migrations here.
const SCHEMA = [init].join('\n');

/**
 * Apply migration schema to the given D1 database instance.
 * Drops all user tables first (indexes drop automatically) so it is safe to
 * call repeatedly (once per test via beforeEach).
 *
 * @param {D1Database} db - e.g. env.RF_MCP_CACHE
 */
export async function applyMigration(db) {
  // Discover and drop all user tables. Indexes are dropped automatically.
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

  // Apply all migrations. Split on ';' followed by optional whitespace + newline.
  // Assumes statement-per-line SQL (current style of 0001_init.sql). Will need
  // a smarter splitter if a future migration introduces CREATE TRIGGER blocks
  // (semicolons inside BEGIN..END) or quoted strings containing ";\n".
  const stmts = SCHEMA.split(/;\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    await db.prepare(stmt).run();
  }
}
