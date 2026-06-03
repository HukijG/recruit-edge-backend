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
} from './route-map.js';
import { proxyToDashboard } from './proxy.js';

// Re-export the DO class so wrangler's durable_objects binding resolves it.
export { MusicRemoteState } from './music-do.js';

// Fixed DO name — one global music-remote instance.
const DO_NAME = 'global';

// GLOBAL command rate-limiting — these seven command routes are SERIALIZED +
// RATE-LIMITED globally (across ALL extension consumers) by routing them THROUGH the
// singleton DO instead of a stateless proxy. The DO is the only shared point across
// consumers, so the rate-limit state lives there. The rate-limit mode is per
// CATEGORY (CATEGORY_MODE in music-do.js); the DO is route-AGNOSTIC (it sees only
// { category, dashboardPath, body }), so this route->category map is the ONLY place
// the route->category relationship lives.
//
//   'toggle'  — pause + resume merged (throttle, leading-edge 5s drop): only one
//               transport toggle per window lands, so concurrent pause/play don't
//               flicker the song.
//   'next'    — next (throttle, leading-edge 5s drop): one skip per window.
//   'prev'    — prev (burst token-bucket, 2-per-3s then 1s): preserves the
//               "double-tap to go back" gesture while blocking sustained spam.
//   'play'    — play + playlist-play (latest-wins debounce): the most expensive
//               new-audio op, so the most protection.
//   'enqueue' — enqueue (save-all FIFO, 20s spacing): every queued song lands.
//
// The remaining routes (volume / search / playlist-search / playlist-contents) STAY
// direct stateless proxies — no rate limit.
const ROUTE_CATEGORY = {
  pause: 'toggle',
  resume: 'toggle',
  next: 'next',
  prev: 'prev',
  play: 'play',
  'playlist-play': 'play',
  enqueue: 'enqueue',
};

// The DO-routed command set (keys of ROUTE_CATEGORY).
const DO_ROUTES = new Set(Object.keys(ROUTE_CATEGORY));

// Routes whose DO response is forwarded to the extension VERBATIM. pause/resume
// deliver INLINE through the throttle gate and the DO returns the dashboard's own
// response (status + body) — preserving the pre-throttle DIRECT-proxy contract where
// the extension saw the dashboard reply. (On a coalesced drop the DO returns a
// synthetic 200 { ok:true, coalesced:true }; on dashboard failure a 502 — both still
// 2xx/structured, so the extension's handling is unchanged.) The other DO routes are
// fire-and-forget and get a uniform 202 (see below).
const VERBATIM_DO_ROUTES = new Set(['pause', 'resume']);

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
    //
    // ORDER MATTERS: validate the INBOUND request shape FIRST (this worker's own
    // contract — route-map.js fully specifies it), THEN resolve the outbound
    // dashboard sub-path. A malformed client request (bad direction, non-numeric
    // id, missing q, malformed JSON) must return a 400 describing the client's
    // error — NOT a 501 "dashboard path unset (escalation 1)", which is about the
    // UNFROZEN outbound wiring and would mislead the client into thinking the
    // route is unimplemented when their own input was invalid. The two concerns
    // are independent; inbound validation does not depend on outbound wiring.
    let init;
    let querySuffix = '';
    if (route.kind === 'transport') {
      init = { method: 'POST', body: JSON.stringify({}) };
    } else if (route.kind === 'volume') {
      const body = await readJsonBody(request);
      if (body === null) return json(400, { ok: false, error: 'malformed JSON body' });
      // Forward { direction } VERBATIM. The dashboard's POST /api/remote/volume
      // deserializes VolumeBody { direction: 'up'|'down' } and owns the ±step
      // magnitude server-side (single source of truth) — the worker must NOT
      // pre-compute a delta, or the dashboard 422s on the unexpected shape.
      if (body.direction !== 'up' && body.direction !== 'down') {
        return json(400, { ok: false, error: "direction must be 'up' or 'down'" });
      }
      init = { method: 'POST', body: JSON.stringify({ direction: body.direction }) };
    } else if (route.kind === 'id') {
      const body = await readJsonBody(request);
      if (body === null) return json(400, { ok: false, error: 'malformed JSON body' });
      const parsed = parseDeezerId(body.id);
      if (!parsed.ok) return json(400, { ok: false, error: 'id must be a numeric Deezer id' });
      // Forward the id as the canonical digit-STRING (the dashboard's IdBody
      // deserializes { id: String }, so a JSON NUMBER is 422 Unprocessable).
      // parsed.idStr is the parser's single source of truth — NOT a lossy Number
      // round-trip (String(Number('007'))==='7', String(Number('9007199254740993'))
      // ==='9007199254740992'). parseDeezerId is still the 400 gate above.
      init = { method: 'POST', body: JSON.stringify({ id: parsed.idStr }) };
    } else if (route.kind === 'search') {
      const q = url.searchParams.get('q');
      if (q == null || q.length === 0) return json(400, { ok: false, error: 'q is required' });
      querySuffix = `?q=${encodeURIComponent(q)}`;
      init = { method: 'GET' };
    } else if (route.kind === 'contents') {
      const parsed = parseDeezerId(url.searchParams.get('id'));
      if (!parsed.ok) return json(400, { ok: false, error: 'id must be a numeric Deezer id' });
      querySuffix = `?id=${parsed.id}`;
      init = { method: 'GET' };
    } else {
      return new Response('Not Found', { status: 404 });
    }

    // Inbound request is valid. NOW resolve the outbound dashboard sub-path; an
    // unset placeholder surfaces loudly as 501 (escalation 1).
    let mappedPath;
    try {
      mappedPath = throwIfUnset(routeName, API_REMOTE_PATH[routeName]) + querySuffix;
    } catch (err) {
      return json(501, { ok: false, error: err.message });
    }

    // DO-routed commands: serialize + rate-limit globally via the singleton DO.
    //
    // The inbound shape is already validated above (a malformed command still 400s
    // and is NEVER forwarded). These routes carry no query suffix, so mappedPath is
    // the bare dashboard sub-path. Hand the command to the DO, which applies the
    // category's mode (throttle / burst / latest-wins / queue) and either delivers
    // inline (toggle/next/prev) or accepts for deferred drain (play/enqueue).
    //
    // The DO-stub fetch is wrapped in the SAME structured-502 discipline as the
    // direct proxy path below, so a DO overload / broken-input-gate / command
    // exception surfaces as a structured json error (reusing code:
    // 'dashboard_unreachable' for extension-side uniformity) rather than an opaque
    // runtime 500.
    if (DO_ROUTES.has(routeName)) {
      let doResp;
      try {
        doResp = await getDoStub(env).fetch(
          new Request('https://do/enqueue-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              category: ROUTE_CATEGORY[routeName],
              dashboardPath: mappedPath,
              body: init.body ?? null,
            }),
          }),
        );
      } catch {
        return json(502, {
          ok: false,
          code: 'dashboard_unreachable',
          error: 'music command unavailable',
        });
      }
      // pause/resume forward the dashboard's own reply verbatim (real-response
      // contract). next/prev also deliver inline but keep the historical
      // fire-and-forget 202 (the extension reads transport truth from the now-playing
      // WS, not this reply); play/playlist-play/enqueue are deferred and the DO
      // already returns the 202 { queued } envelope (incl. the queue_full backstop),
      // so those forward verbatim too.
      if (VERBATIM_DO_ROUTES.has(routeName)) {
        return doResp;
      }
      if (routeName === 'next' || routeName === 'prev') {
        return json(202, { ok: true, queued: true });
      }
      return doResp;
    }

    // The dashboard is a parallel-built dependency that may not exist / be
    // reachable yet (DNS failure, cold ingress, unset DASHBOARD_REMOTE_BASE).
    // A bare fetch rejection here would surface as an opaque runtime 500 with no
    // body — inconsistent with every other failure path in this file, which
    // returns a structured json(...). Catch it and return a uniform 502 so the
    // extension's error handling stays consistent regardless of dashboard health.
    let upstream;
    try {
      upstream = await proxyToDashboard(env, mappedPath, init);
      // Stream the dashboard response straight back (status + body), so the
      // extension sees the dashboard's result verbatim.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
      });
    } catch {
      return json(502, {
        ok: false,
        code: 'dashboard_unreachable',
        error: 'music dashboard upstream unavailable',
      });
    }
  },
};
