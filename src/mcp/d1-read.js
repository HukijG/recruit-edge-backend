/**
 * D1 read helpers for the MCP middleware surface.
 *
 * The cache-worker is the sole writer to the rf-mcp-cache D1 database; this
 * worker is read-only.  All reads are wrapped in a Sessions-API session so
 * D1 can route to the closest replica while preserving read-your-writes
 * semantics for callers that thread a bookmark through.
 *
 * In production `withSession()` is always available on the D1 binding.  In
 * miniflare's local D1 implementation it isn't, so `session()` falls back to
 * the raw binding — behaviour is identical for our read-only queries because
 * miniflare runs a single SQLite instance with no replicas to route between.
 *
 * Per spec rev 5, this module reads ONLY thin / immutable columns from the
 * `candidates_v2` / `jobs_v2` / `calls` tables.  The legacy body-blob readers
 * (`SELECT body FROM candidates …`) are gone — callers that need a full
 * candidate body live-fetch via `getRFCandidate` (in `src/rf-client.js`)
 * after resolving the numeric id from this layer.
 */

import { getRFCandidate } from '../rf-client.js';

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

export async function countTable(env, table) {
  const row = await session(env)
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first();
  return row?.n ?? 0;
}

/**
 * Read a single sync_state value by key. Returns null for missing rows.
 * Centralised here so handler call sites use a consistent Sessions-API
 * wrapper around the read.
 *
 * @param {object} env
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function readSyncState(env, key) {
  const row = await session(env)
    .prepare('SELECT value FROM sync_state WHERE key = ?')
    .bind(key)
    .first();
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Thin-schema readers (Task 12) — candidates_v2 and calls tables.
// ---------------------------------------------------------------------------

// SQLite expression-tree depth limit is ~999 placeholders in production; the
// D1 Sessions API and miniflare's local D1 shim enforce a tighter internal
// limit (~480 parameters per statement).  100 per chunk keeps us well inside
// both limits, and for the typical pipeline page (≤200 candidates) results
// in just two roundtrips.
const SQLITE_PARAMS_PER_CHUNK = 100;

/**
 * Fetch a single thin candidate row by RF id.
 * Returns the full thin row (including current_title_at_cache_time /
 * current_company_at_cache_time when they're populated) or null on miss.
 */
export async function getThinCandidateById(env, id) {
  const row = await session(env)
    .prepare(`SELECT id, name, linkedin_profile, added_time_ms,
                     current_title_at_cache_time, current_company_at_cache_time
              FROM candidates_v2 WHERE id = ?`)
    .bind(Number(id))
    .first();
  return row ?? null;
}

/**
 * Resolve a numeric candidate id to a full RF candidate body, going via the
 * thin-cache sanity check + live RF `/candidate/get`. Used by every MCP
 * handler that previously read `SELECT body FROM candidates`.
 *
 * Returns:
 *   { ok: true, value: <full-rf-body> }
 *   { ok: false, reason: 'not_found' }   — id not in thin cache
 *
 * RF errors propagate as the typed `RFError` / `RFRateLimitedError` /
 * `RFTransientError` subclasses (defined in `src/rf-client.js`); the caller
 * is expected to catch and emit the appropriate envelope. We do NOT swallow
 * those here — the caller knows which envelope shape to surface (404 vs
 * 200 + `kind: 'rf_unavailable'`).
 *
 * @param {object} env
 * @param {number|string} id
 * @returns {Promise<{ok: true, value: object} | {ok: false, reason: 'not_found'}>}
 */
export async function getFullCandidateById(env, id) {
  const thin = await getThinCandidateById(env, id);
  if (!thin) return { ok: false, reason: 'not_found' };
  const body = await getRFCandidate(thin.id, env);
  return { ok: true, value: body };
}

/**
 * Batch fetch thin candidate rows by id-list, preserving the input order.
 * Chunks the id-list to stay under SQLite's expression depth.
 *
 * Returns full thin row including current_title_at_cache_time and
 * current_company_at_cache_time.  Ids absent from the cache are silently
 * omitted (no error).
 *
 * Duplicate ids in input are deduped; output preserves the order of FIRST
 * occurrence per input id.
 *
 * Used by pipeline tools (Tasks 15/16) for thin-only hydration of an
 * RF /job/pipeline response.
 *
 * @param {object} env
 * @param {number[]} ids - RF candidate ids to fetch
 * @returns {Promise<object[]>}
 */
export async function getCandidatesByIds(env, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  // Dedup: preserves first-occurrence order, drops non-finite values.
  const numericIds = [...new Set(ids.map(Number).filter(Number.isFinite))];

  const byId = new Map();
  for (let i = 0; i < numericIds.length; i += SQLITE_PARAMS_PER_CHUNK) {
    const chunk = numericIds.slice(i, i + SQLITE_PARAMS_PER_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await session(env)
      .prepare(`SELECT id, name, linkedin_profile, added_time_ms,
                       current_title_at_cache_time, current_company_at_cache_time
                FROM candidates_v2 WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all();
    for (const row of results) byId.set(row.id, row);
  }
  return numericIds.map(id => byId.get(id)).filter(Boolean);
}

/**
 * Step-1 read for /mcp/candidate-call-notes. Per-record auth via
 * target_dialpad_id — only rows belonging to the requesting consultant's
 * Dialpad user id are returned.
 *
 * @param {object} env
 * @param {string} targetDialpadId   Consultant's Dialpad user id (from JWT)
 * @param {number} rfCandidateId     RF candidate id
 * @param {object} [opts]
 * @param {number} [opts.minDurationMs=120000]         Default 2 min
 * @param {number} [opts.startedAfterMs=0]
 * @param {number} [opts.startedBeforeMs=Date.now()]
 * @param {number} [opts.limit=20]
 * @returns {Promise<{call_id: string, date_started_ms: number, duration_ms: number, direction: string}[]>}
 */
export async function getCallsForCandidate(env, targetDialpadId, rfCandidateId, opts = {}) {
  const minDurationMs   = opts.minDurationMs   ?? 120_000;
  const startedAfterMs  = opts.startedAfterMs  ?? 0;
  const startedBeforeMs = opts.startedBeforeMs ?? Date.now();
  const limit           = opts.limit ?? 20;

  const { results } = await session(env)
    .prepare(`SELECT call_id, date_started_ms, duration_ms, direction
              FROM calls
              WHERE target_dialpad_id = ?
                AND rf_candidate_id   = ?
                AND duration_ms       >= ?
                AND date_started_ms BETWEEN ? AND ?
              ORDER BY date_started_ms DESC
              LIMIT ?`)
    .bind(String(targetDialpadId), Number(rfCandidateId), minDurationMs, startedAfterMs, startedBeforeMs, limit)
    .all();
  return results;
}
