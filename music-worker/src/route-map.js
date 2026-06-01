/**
 * Inbound /music/* contract + the outbound /music/* -> dashboard /api/remote/*
 * mapping.
 *
 * TWO surfaces, sharply separated by ownership:
 *
 *  - INBOUND (this worker's OWN API, fully specified here): the extension calls
 *    the routes in MUSIC_ROUTES below. Shapes are frozen in this module and in
 *    docs/music-worker.md. Volume magnitude is server-fixed (+/-10 percentage
 *    points); Deezer ids are numeric.
 *
 *  - OUTBOUND (the FROZEN cross-repo contract, escalation 1): this worker proxies
 *    to the dashboard at ${DASHBOARD_REMOTE_BASE}${path} with header
 *    X-Remote-Key. The dashboard sub-path STRINGS are NOT in the frozen contract
 *    and no spec exists in the worktree, so they ship as compile-clean
 *    placeholders guarded by throwIfUnset(): the build/dry-run stays green
 *    (strings, never undefined) while any accidental LIVE call fails loudly.
 *    Frozen+hard-coded bits (X-Remote-Key, DASHBOARD_REMOTE_BASE, volume +/-10,
 *    Deezer numeric ids) are NOT placeholders.
 */

// Server-fixed volume delta, in percentage points. FROZEN by the cross-repo
// contract — the magnitude is NEVER client-supplied; the client only sends a
// direction. Named constant, not an inline magic number.
export const VOLUME_STEP_POINTS = 10;

// Sentinel prefix marking an UNSET dashboard sub-path. A real path will never
// start with this, so throwIfUnset can detect a placeholder reaching a live call.
const UNSET_PREFIX = '__UNSET_';

/**
 * Dashboard /api/remote/* sub-paths, keyed by inbound /music/* route name.
 *
 * ESCALATION 1: these 11 strings are genuinely unfrozen (no music-remote spec
 * exists). They are compile-clean placeholders so `wrangler deploy --dry-run`
 * passes; throwIfUnset() makes any accidental live proxy call fail loudly with a
 * pointer to the escalation. Replace each value with the operator-confirmed
 * sub-path; leave the keys as-is.
 */
export const API_REMOTE_PATH = {
  pause: `${UNSET_PREFIX}pause__`,
  resume: `${UNSET_PREFIX}resume__`,
  next: `${UNSET_PREFIX}next__`,
  prev: `${UNSET_PREFIX}prev__`,
  volume: `${UNSET_PREFIX}volume__`,
  search: `${UNSET_PREFIX}search__`,
  play: `${UNSET_PREFIX}play__`,
  enqueue: `${UNSET_PREFIX}enqueue__`,
  'playlist-play': `${UNSET_PREFIX}playlist_play__`,
  'playlist-search': `${UNSET_PREFIX}playlist_search__`,
  'playlist-contents': `${UNSET_PREFIX}playlist_contents__`,
};

/**
 * Throw if a dashboard sub-path is still an unset placeholder. Called at proxy
 * time, NEVER at module load (so the worker boots + dry-runs clean). The message
 * names the route + the escalation so an operator can wire it immediately.
 *
 * @param {string} route
 * @param {string} path
 * @returns {string} the same path when it is real
 */
export function throwIfUnset(route, path) {
  if (typeof path !== 'string' || path.startsWith(UNSET_PREFIX)) {
    throw new Error(
      `music api-remote path unset for route '${route}', see escalation 1 (dashboard /api/remote/* sub-paths)`,
    );
  }
  return path;
}

/**
 * Inbound /music/* route table. Each entry declares its HTTP method, the request
 * shape this worker enforces, and how it maps to the dashboard.
 *
 * `kind`:
 *   'transport'      — POST, empty {} body (pause/resume/next/prev).
 *   'volume'         — POST { direction: 'up'|'down' }; mapped to a fixed
 *                      +/-VOLUME_STEP_POINTS delta server-side.
 *   'id'             — POST { id: <numeric Deezer id> } (play/enqueue/playlist-play).
 *   'search'         — GET ?q=<free text> (search/playlist-search).
 *   'contents'       — GET ?id=<numeric Deezer id> (playlist-contents).
 */
export const MUSIC_ROUTES = {
  pause: { method: 'POST', kind: 'transport' },
  resume: { method: 'POST', kind: 'transport' },
  next: { method: 'POST', kind: 'transport' },
  prev: { method: 'POST', kind: 'transport' },
  volume: { method: 'POST', kind: 'volume' },
  play: { method: 'POST', kind: 'id' },
  enqueue: { method: 'POST', kind: 'id' },
  'playlist-play': { method: 'POST', kind: 'id' },
  search: { method: 'GET', kind: 'search' },
  'playlist-search': { method: 'GET', kind: 'search' },
  'playlist-contents': { method: 'GET', kind: 'contents' },
};

/**
 * Coerce + validate a Deezer id as a non-negative integer. Deezer ids are
 * numeric (FROZEN). Accepts a number or a numeric string; rejects everything
 * else (=> the caller returns 400).
 *
 * @param {unknown} raw
 * @returns {{ ok: true, id: number } | { ok: false }}
 */
export function parseDeezerId(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { ok: true, id: raw };
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    return { ok: true, id: Number(raw.trim()) };
  }
  return { ok: false };
}

/**
 * Map a volume direction to a signed percentage-point delta. Magnitude is fixed
 * server-side; only the sign comes from the client.
 *
 * @param {unknown} direction
 * @returns {{ ok: true, delta: number } | { ok: false }}
 */
export function volumeDeltaFor(direction) {
  if (direction === 'up') return { ok: true, delta: VOLUME_STEP_POINTS };
  if (direction === 'down') return { ok: true, delta: -VOLUME_STEP_POINTS };
  return { ok: false };
}
