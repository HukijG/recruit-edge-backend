/**
 * rf-music-remote — entry router.
 *
 * No instrument() wrapper, no @microlabs, no OTel, no flow.name (observability
 * waived for the music remote). Bare `export default { fetch }`.
 *
 * Surfaces:
 *   - HTTP /music/{pause,resume,next,prev,volume,play,enqueue,playlist-play,
 *     search,playlist-search,playlist-contents} — auth-gated, proxied to the
 *     dashboard /api/remote/* with X-Remote-Key over DASHBOARD_REMOTE_BASE.
 *   - POST /music/ws-ticket — auth-gated; issues a single-use WS ticket from the DO.
 *   - GET  /music/now-playing (Upgrade: websocket) — WS now-playing fan-out; the
 *     DO redeems the subprotocol ticket (so the WS path itself needs no header
 *     auth that would leak into a URL/log).
 *
 * The single DO instance is addressed by a fixed name — music control is
 * single-target.
 */

import { authMusicRequest } from './auth-music.js';
import {
  MUSIC_ROUTES,
  API_REMOTE_PATH,
  throwIfUnset,
  parseDeezerId,
  volumeDeltaFor,
} from './route-map.js';
import { proxyToDashboard } from './proxy.js';

// Re-export the DO class so wrangler's durable_objects binding resolves it.
export { MusicRemoteState } from './music-do.js';

// Fixed DO name — one global music-remote instance.
const DO_NAME = 'global';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getDoStub(env) {
  const id = env.MUSIC_REMOTE.idFromName(DO_NAME);
  return env.MUSIC_REMOTE.get(id);
}

async function readJsonBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null; // signals malformed JSON
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // WS now-playing upgrade. The DO redeems the subprotocol ticket; no
    // Authorization header is required on the upgrade itself (Option B).
    if (pathname === '/music/now-playing') {
      const upgrade = request.headers.get('Upgrade');
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return json(426, { ok: false, error: 'expected websocket upgrade' });
      }
      return getDoStub(env).fetch(request);
    }

    if (!pathname.startsWith('/music/')) {
      return new Response('Not Found', { status: 404 });
    }

    // Everything below requires the extension auth scheme.
    const auth = await authMusicRequest(request, env);
    if (!auth.ok) {
      return json(auth.status, { ok: false, code: auth.code, error: auth.message });
    }

    // WS-ticket issue (Option B): auth-gated, returns a single-use ticket.
    if (pathname === '/music/ws-ticket') {
      if (request.method !== 'POST') {
        return json(405, { ok: false, error: 'method not allowed' });
      }
      return getDoStub(env).fetch(
        new Request('https://do/ws-ticket', { method: 'POST' }),
      );
    }

    const routeName = pathname.slice('/music/'.length);
    const route = MUSIC_ROUTES[routeName];
    if (!route) {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== route.method) {
      return json(405, { ok: false, error: 'method not allowed' });
    }

    // Build the dashboard request per route kind.
    let mappedPath;
    let init;
    try {
      mappedPath = throwIfUnset(routeName, API_REMOTE_PATH[routeName]);
    } catch (err) {
      // Placeholder hit a live call — surface loudly (escalation 1).
      return json(501, { ok: false, error: err.message });
    }

    if (route.kind === 'transport') {
      init = { method: 'POST', body: JSON.stringify({}) };
    } else if (route.kind === 'volume') {
      const body = await readJsonBody(request);
      if (body === null) return json(400, { ok: false, error: 'malformed JSON body' });
      const v = volumeDeltaFor(body.direction);
      if (!v.ok) return json(400, { ok: false, error: "direction must be 'up' or 'down'" });
      init = { method: 'POST', body: JSON.stringify({ delta: v.delta }) };
    } else if (route.kind === 'id') {
      const body = await readJsonBody(request);
      if (body === null) return json(400, { ok: false, error: 'malformed JSON body' });
      const parsed = parseDeezerId(body.id);
      if (!parsed.ok) return json(400, { ok: false, error: 'id must be a numeric Deezer id' });
      init = { method: 'POST', body: JSON.stringify({ id: parsed.id }) };
    } else if (route.kind === 'search') {
      const q = url.searchParams.get('q');
      if (q == null || q.length === 0) return json(400, { ok: false, error: 'q is required' });
      mappedPath = `${mappedPath}?q=${encodeURIComponent(q)}`;
      init = { method: 'GET' };
    } else if (route.kind === 'contents') {
      const parsed = parseDeezerId(url.searchParams.get('id'));
      if (!parsed.ok) return json(400, { ok: false, error: 'id must be a numeric Deezer id' });
      mappedPath = `${mappedPath}?id=${parsed.id}`;
      init = { method: 'GET' };
    } else {
      return new Response('Not Found', { status: 404 });
    }

    const upstream = await proxyToDashboard(env, mappedPath, init);
    // Stream the dashboard response straight back (status + body), so the
    // extension sees the dashboard's result verbatim.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
    });
  },
};
