/**
 * sync_state table helpers.
 *
 * Simple key/value store backed by the sync_state D1 table:
 *   key   TEXT PRIMARY KEY
 *   value TEXT NOT NULL
 *
 * Used to persist opaque sync cursors and flags across scheduled invocations.
 */

/**
 * Read a sync state value by key.
 *
 * @param {object} env - Worker env with RF_MCP_CACHE D1 binding
 * @param {string} key
 * @returns {Promise<string|null>} The stored value, or null if not found.
 */
export async function readSyncState(env, key) {
  const row = await env.RF_MCP_CACHE
    .prepare('SELECT value FROM sync_state WHERE key = ?')
    .bind(key)
    .first();
  return row ? row.value : null;
}

/**
 * Write (upsert) a sync state value.
 *
 * @param {object} env - Worker env with RF_MCP_CACHE D1 binding
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function writeSyncState(env, key, value) {
  await env.RF_MCP_CACHE
    .prepare(
      'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .bind(key, value)
    .run();
}

/**
 * Delete a sync state entry by key.
 *
 * @param {object} env - Worker env with RF_MCP_CACHE D1 binding
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteSyncState(env, key) {
  await env.RF_MCP_CACHE
    .prepare('DELETE FROM sync_state WHERE key = ?')
    .bind(key)
    .run();
}
