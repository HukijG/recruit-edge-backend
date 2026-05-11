/**
 * Custom-field name→id map for RF `custom_field.<id>` filter routing.
 *
 * Spec rev 5 RF-7 routes mutable `technology` / `segment` / `role` filters
 * through RF as `{key: 'custom_field.<id>', conjunction: 'in', values: [...]}`.
 * RF returns these fields with their numeric ids on `/candidate/custom-field/list`;
 * this module caches that mapping in worker globals so a single isolate
 * doesn't re-fetch the schema on every search request.
 *
 * Two consumers in `src/mcp/candidate-search.js`:
 *   1. The fuzzy-resolver universe — what canonical values exist for
 *      "technology" / "segment" / "role"? Comes from each field's `options[]`.
 *   2. The RF filter builder — when emitting a `custom_field.<id>` filter,
 *      look up the field's numeric id from the cached map.
 *
 * On RF failure (network / 5xx after retry / 429) the caller surfaces a
 * `warning: 'custom_field_map_unavailable'` envelope instead of silently
 * dropping the filter. We never silent-drop a user filter — every filter
 * either applies or generates an observable warning.
 */

import { fetchRFCustomFieldList } from '../rf-client.js';

const CACHE_TTL_MS = 5 * 60_000; // 5 min, same cadence as the snapshot refresh
const CACHE_KEY = '__rfMcpCustomFieldMap';

/**
 * Normalise an RF custom-field name to its lookup key. Case-insensitive +
 * underscore-tolerant so a user-typed "technology" matches RF's "Technology",
 * and `tech_stack` matches "Tech Stack".
 *
 * @param {string} s
 * @returns {string}
 */
function normaliseName(s) {
  if (typeof s !== 'string') return '';
  return s.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

/**
 * Build the name→{id, options} map from RF's `/candidate/custom-field/list`
 * response. Keys are lowercased, whitespace-collapsed (see `normaliseName`).
 *
 * Each value is `{ id: <number>, name: <RF-canonical-name>, options: <string[]> }`.
 * `options` is empty for free-text fields; for single-select / multi-select
 * fields it is the enumerated value list and feeds the fuzzy resolver.
 *
 * @param {object[]} fields
 * @returns {Map<string, {id: number, name: string, options: string[]}>}
 */
function buildMap(fields) {
  const out = new Map();
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    if (!f || typeof f !== 'object') continue;
    const id = typeof f.id === 'number' ? f.id : parseInt(f.id, 10);
    if (!Number.isFinite(id)) continue;
    const name = typeof f.name === 'string' ? f.name : '';
    if (!name) continue;
    // RF returns options as either:
    //   `options: [{name: 'Python'}, ...]` (canonical),
    //   `options: ['Python', ...]` (sometimes),
    //   absent (text fields).
    const rawOpts = Array.isArray(f.options) ? f.options : [];
    const options = rawOpts
      .map((o) => (typeof o === 'string' ? o : o?.name ?? o?.value))
      .filter((s) => typeof s === 'string' && s.length > 0);
    out.set(normaliseName(name), { id, name, options });
  }
  return out;
}

/**
 * Get the cached custom-field map, refreshing from RF on a miss / expiry.
 *
 * Cache is module-scoped on `globalThis[CACHE_KEY]` so it survives across
 * requests within an isolate; refreshed every 5 minutes. RF failures bubble
 * up as the typed error from `fetchRFCustomFieldList`; the search handler
 * catches and emits a `custom_field_map_unavailable` warning so the user
 * sees the gap.
 *
 * @param {object} env
 * @returns {Promise<Map<string, {id: number, name: string, options: string[]}>>}
 */
export async function getCustomFieldMap(env) {
  const G = globalThis;
  const cached = G[CACHE_KEY];
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached.map;
  }
  const fields = await fetchRFCustomFieldList(env);
  const map = buildMap(fields);
  G[CACHE_KEY] = { map, fetchedAtMs: now };
  return map;
}

/**
 * Test-only: reset the cached map so tests can drive fresh fetches per case.
 *
 * Mirrors `resetSnapshot()` in `snapshot.js`. Not exported through the public
 * surface (callers shouldn't need it), but lives next to `getCustomFieldMap`
 * so test imports can find it without a deep path.
 */
export function _resetCustomFieldMapForTests() {
  delete globalThis[CACHE_KEY];
}

/**
 * Look up one field's `{id, options}` by friendly name. Tolerates
 * case / underscore variants via `normaliseName`. Returns `undefined` when
 * the field doesn't exist in this account's schema.
 *
 * @param {Map} map
 * @param {string} fieldName
 */
export function lookupField(map, fieldName) {
  return map.get(normaliseName(fieldName));
}
