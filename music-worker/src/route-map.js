/**
 * Inbound /music/* contract + the outbound /music/* -> dashboard /api/remote/*
 * mapping.
 *
 * TWO surfaces, sharply separated by ownership:
 *
 *  - INBOUND (this worker's OWN API, fully specified here): the extension calls
 *    the routes in MUSIC_ROUTES below. Shapes are frozen in this module and in
 *    docs/music-worker.md. The client sends only a volume DIRECTION ('up'|'down');
 *    the DASHBOARD owns the fixed +/-step magnitude (single source of truth) — the
 *    worker forwards { direction } verbatim and never computes a delta. Deezer ids
 *    are numeric.
 *
 *  - OUTBOUND (the FROZEN cross-repo contract): this worker proxies to the
 *    dashboard at ${DASHBOARD_REMOTE_BASE}${path} with header X-Remote-Key. The
 *    dashboard sub-path STRINGS are now CONFIRMED against the dashboard's actual
 *    /api/remote/* routes (escalation 1 resolved). throwIfUnset() is retained as a
 *    safety net but never fires now that every value is real. Frozen+hard-coded
 *    bits (X-Remote-Key, DASHBOARD_REMOTE_BASE, Deezer numeric ids) are part of the
 *    same contract. The volume +/-step magnitude is NOT in this worker — the
 *    dashboard owns it; the worker forwards the bare { direction }.
 */

// Sentinel prefix marking an UNSET dashboard sub-path. A real path will never
// start with this, so throwIfUnset can detect a placeholder reaching a live call.
const UNSET_PREFIX = '__UNSET_';

/**
 * Dashboard /api/remote/* sub-paths, keyed by inbound /music/* route name.
 *
 * ESCALATION 1 (RESOLVED): these 11 sub-paths are now CONFIRMED against the
 * dashboard's actual /api/remote/* routes (orchestrator-verified). The 'search' /
 * 'playlist-search' routes forward ?q= and 'playlist-contents' forwards ?id=, per
 * the MUSIC_ROUTES kinds — that query-forwarding mechanism is unchanged.
 * throwIfUnset() is retained for safety but, with every value real, never fires.
 */
export const API_REMOTE_PATH = {
  pause: '/api/remote/pause',
  resume: '/api/remote/resume',
  next: '/api/remote/next',
  prev: '/api/remote/prev',
  volume: '/api/remote/volume',
  search: '/api/remote/songs/results',
  play: '/api/remote/songs/play',
  enqueue: '/api/remote/songs/enqueue',
  'playlist-play': '/api/remote/playlists/play',
  'playlist-search': '/api/remote/playlists/search',
  'playlist-contents': '/api/remote/playlists/contents',
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
 *   'volume'         — POST { direction: 'up'|'down' }; forwarded VERBATIM to the
 *                      dashboard, which owns the fixed +/-step magnitude.
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
 * SINGLE SOURCE OF TRUTH for the forwarded id. The validation gate AND the value
 * the worker forwards to the dashboard are ONE computation here, so they cannot
 * drift on a future edit.
 *   - `id`    — the numeric form, for any numeric use.
 *   - `idStr` — THE value forwarded to the dashboard. The dashboard's IdBody
 *               deserializes `{ id: String }`, so a JSON NUMBER is 422
 *               Unprocessable; the canonical digit-STRING is forwarded instead.
 *               idStr is the caller's exact trimmed digit-string — NOT a Number
 *               round-trip (String(Number('007'))==='7' drops leading zeros,
 *               String(Number('9007199254740993'))==='9007199254740992' truncates
 *               above MAX_SAFE_INTEGER). For a JSON-number input idStr is
 *               String(raw); for a string input it is raw.trim().
 *
 * @param {unknown} raw
 * @returns {{ ok: true, id: number, idStr: string } | { ok: false }}
 */
export function parseDeezerId(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { ok: true, id: raw, idStr: String(raw) };
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const t = raw.trim();
    return { ok: true, id: Number(t), idStr: t };
  }
  return { ok: false };
}

