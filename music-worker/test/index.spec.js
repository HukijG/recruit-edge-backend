import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';

// Integration tests for the entry router (src/index.js) — the seam where auth +
// route-map + proxy meet. The unit pieces are covered elsewhere; this file proves
// their COMPOSITION: auth ordering, the pre-auth WS branch, route/method mapping,
// per-kind body/query validation, the throwIfUnset -> 501 mapping, and the
// verbatim status+body pass-through of the dashboard Response.
//
// Auth: every /music/* route below uses the LEGACY X-Extension-Token path
// (LINKEDIN_EXTENSION_SECRET = 'test-extension-secret' in vitest.config.js), so
// the JWT path is not exercised here (it is covered in auth-music.spec.js).

const LEGACY_TOKEN = 'test-extension-secret';

const BASE = 'https://music.test.invalid';

function authedHeaders(extra = {}) {
  return { 'X-Extension-Token': LEGACY_TOKEN, ...extra };
}

// undici's MockResponseCallbackOptions.headers is either a `Headers` instance or
// a plain record (and casing is not guaranteed). Read a header robustly.
function headerOf(headers, name) {
  if (headers == null) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

describe('entry router — unauthenticated + liveness + WS pre-auth branch', () => {
  it('/health -> 200 "ok" (unauthenticated)', async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('/music/pause without a token -> 401 auth_missing (auth runs before routing)', async () => {
    const res = await SELF.fetch(`${BASE}/music/pause`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('auth_missing');
  });

  it('/music/pause with a wrong token -> 401 auth_legacy_invalid', async () => {
    const res = await SELF.fetch(`${BASE}/music/pause`, {
      method: 'POST',
      headers: { 'X-Extension-Token': 'nope' },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('auth_legacy_invalid');
  });

  it('/music/now-playing without an Upgrade header -> 426 (pre-auth branch, no token required to reach it)', async () => {
    const res = await SELF.fetch(`${BASE}/music/now-playing`);
    expect(res.status).toBe(426);
    expect((await res.json()).error).toMatch(/websocket/i);
  });

  it('a non-/music path -> 404 (before the auth gate)', async () => {
    const res = await SELF.fetch(`${BASE}/not-music/x`);
    expect(res.status).toBe(404);
  });
});

describe('entry router — routing + method mapping (authed)', () => {
  it('unknown /music/<x> -> 404 (after auth passes)', async () => {
    const res = await SELF.fetch(`${BASE}/music/frobnicate`, {
      method: 'POST',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('wrong method on a known route -> 405 (GET on POST-only /music/pause)', async () => {
    const res = await SELF.fetch(`${BASE}/music/pause`, {
      method: 'GET',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(405);
    expect((await res.json()).error).toMatch(/method not allowed/i);
  });

  it('/music/ws-ticket with GET -> 405 (POST-only, auth-gated)', async () => {
    const res = await SELF.fetch(`${BASE}/music/ws-ticket`, {
      method: 'GET',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(405);
  });

  it('a confirmed DIRECT route reaches the proxy (escalation 1 resolved): unreachable dashboard -> 502, NOT 501', async () => {
    // API_REMOTE_PATH.search is a CONFIRMED sub-path (/api/remote/songs/results), so
    // the throwIfUnset 501 placeholder branch no longer fires. With no fetchMock
    // active in this block the outbound fetch to the (non-existent) dashboard rejects,
    // so the router returns the structured 502 dashboard_unreachable — proving the
    // request flows to the proxy seam instead of short-circuiting at 501. (search is a
    // DIRECT proxy route, chosen so this test does NOT consume the shared 'global' DO's
    // throttle window — pause/resume routing is covered in its own block below.)
    const res = await SELF.fetch(`${BASE}/music/search?q=ping`, {
      method: 'GET',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('dashboard_unreachable');
  });
});

// Inbound-request validation is this worker's OWN contract and runs BEFORE the
// outbound dashboard sub-path is resolved + proxied. So a malformed client request
// returns a 400 describing the client's error and never reaches the outbound fetch
// at all. These tests pin that ordering.
describe('entry router — per-kind body/query validation (authed, runs before outbound-path resolution)', () => {
  it('volume with a missing/bad direction -> 400 (validation precedes any outbound call)', async () => {
    const res = await SELF.fetch(`${BASE}/music/volume`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ direction: 'sideways' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/direction/);
  });

  it('volume with malformed JSON -> 400', async () => {
    const res = await SELF.fetch(`${BASE}/music/volume`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/malformed JSON/i);
  });

  it('id route (play) with a non-numeric id -> 400', async () => {
    const res = await SELF.fetch(`${BASE}/music/play`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: 'abc' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/numeric Deezer id/);
  });

  it('search with a missing q -> 400', async () => {
    const res = await SELF.fetch(`${BASE}/music/search`, {
      method: 'GET',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/q is required/);
  });

  it('playlist-contents with a non-numeric id -> 400', async () => {
    const res = await SELF.fetch(`${BASE}/music/playlist-contents?id=nope`, {
      method: 'GET',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/numeric Deezer id/);
  });
});

// The proxy seam — exercised against the CONFIRMED dashboard sub-paths
// (escalation 1 resolved) in API_REMOTE_PATH, mocking the OUTBOUND fetch with
// `fetchMock` (the supported undici MockAgent — its responses are built inside the
// worker's request context, avoiding the cross-request-I/O error that a
// `vi.spyOn(globalThis,'fetch')` Response would hit under SELF.fetch). This proves
// the router composes the correct dashboard request body + headers AND streams the
// dashboard Response status+body back verbatim — the half the unit tests
// (proxy.spec.js / route-map.spec.js) cannot cover. Each interceptor uses the real
// confirmed sub-path, so no API_REMOTE_PATH mutation/restore is needed.
describe('entry router — proxy composition + verbatim pass-through', () => {
  const DASH_ORIGIN = 'https://dashboard.test.invalid';

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    // Assert every queued interceptor was consumed.
    fetchMock.assertNoPendingInterceptors();
  });

  it('volume up -> forwards POST {direction:"up"} VERBATIM with X-Remote-Key, streams the dashboard 200 body verbatim', async () => {
    let seen;
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/volume', method: 'POST' })
      .reply((opts) => {
        seen = opts;
        return { statusCode: 200, data: { ok: true, volume: 80 } };
      });

    const res = await SELF.fetch(`${BASE}/music/volume`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ direction: 'up' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, volume: 80 });
    // The worker forwards the bare direction — the dashboard owns the ±step
    // magnitude (single source of truth). No { delta } shape.
    expect(JSON.parse(seen.body)).toEqual({ direction: 'up' });
    expect(headerOf(seen.headers, 'X-Remote-Key')).toBe('test-remote-key');
  });

  it('volume down -> forwards POST {direction:"down"} verbatim', async () => {
    let seen;
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/volume', method: 'POST' })
      .reply((opts) => {
        seen = opts;
        return { statusCode: 200, data: {} };
      });

    await SELF.fetch(`${BASE}/music/volume`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ direction: 'down' }),
    });

    expect(JSON.parse(seen.body)).toEqual({ direction: 'down' });
  });

  // NOTE: `play` is now a DO-routed command (latest-wins) — it no longer proxies
  // synchronously, so the old 'play -> proxies POST {id:<number>}' direct-proxy
  // assertion is gone. The string-forward proof ({ id:"<digits>" } as a STRING) now
  // lives at the DO drain boundary in music-do.spec.js, where the outbound delivery
  // fetch is observable.

  it('search -> GETs the dashboard with q encoded into the path, status + body passed through verbatim', async () => {
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/songs/results?q=daft%20punk', method: 'GET' })
      .reply(200, [], { headers: { 'Content-Type': 'application/json' } });

    const res = await SELF.fetch(`${BASE}/music/search?q=daft%20punk`, {
      method: 'GET',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // The non-200 verbatim + fetch-rejection->502 seam tests are pinned on the DIRECT
  // /music/volume route (play is now queued and never proxies synchronously). A
  // VALID { direction:'up' } body is sent so inbound validation passes and the
  // request actually reaches proxyToDashboard — the explicit 503/502 assertions
  // (NOT a 400) prove the seam is still covered after the retarget.
  it('a non-200 dashboard response is streamed back verbatim (status + body) — direct /music/volume', async () => {
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/volume', method: 'POST' })
      .reply(503, { ok: false, error: 'audio device busy' });

    const res = await SELF.fetch(`${BASE}/music/volume`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ direction: 'up' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'audio device busy' });
  });

  it('a dashboard fetch rejection -> 502 dashboard_unreachable (structured, not an opaque 500) — direct /music/volume', async () => {
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/volume', method: 'POST' })
      .replyWithError(new TypeError('Network connection lost'));

    const res = await SELF.fetch(`${BASE}/music/volume`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ direction: 'up' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('dashboard_unreachable');
  });
});

// next/prev/play/enqueue/playlist-play are all DO-routed and return 202 { ok:true,
// queued:true } to the extension (the historical fire-and-forget contract; the truth
// returns via the now-playing WS). next/prev deliver INLINE through their gate but
// the router still wraps a uniform 202; play/enqueue/playlist-play are alarm-deferred
// and the DO returns the 202 envelope directly. No fetchMock interceptor is active
// here — next/prev's inline delivery rejects (DNS) and folds to a DO-internal 502,
// and the deferred routes never deliver synchronously, so the 202 proves DO routing,
// not a synchronous proxy. (Per-mode behaviour + delivery bodies live in
// music-do.spec.js, which uses isolated DO stubs.)
describe('entry router — DO-routed commands (202 fire-and-forget)', () => {
  const DO_ROUTED = [
    { route: 'next', body: undefined },
    { route: 'prev', body: undefined },
    { route: 'play', body: JSON.stringify({ id: '3135556' }) },
    { route: 'enqueue', body: JSON.stringify({ id: '3135556' }) },
    { route: 'playlist-play', body: JSON.stringify({ id: '3135556' }) },
  ];

  for (const { route, body } of DO_ROUTED) {
    it(`/music/${route} -> 202 { ok:true, queued:true } (DO-routed, not synchronously proxied)`, async () => {
      const res = await SELF.fetch(`${BASE}/music/${route}`, {
        method: 'POST',
        headers: authedHeaders({ 'Content-Type': 'application/json' }),
        body,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, queued: true });
    });
  }

  it('play with id:"abc" -> 400 and NOT routed (malformed cmd 400s before reaching the DO)', async () => {
    const res = await SELF.fetch(`${BASE}/music/play`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: 'abc' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/numeric Deezer id/);
  });
});

// pause/resume are DO-routed but INLINE (throttle, category `toggle`): unlike the
// fire-and-forget 202 routes, the router forwards the DO's response VERBATIM
// (VERBATIM_DO_ROUTES). This block pins the router-level contract: a delivered toggle
// streams the dashboard's own body back; a coalesced toggle (the throttle window is
// still hot) returns the synthetic 200 { coalesced } with NO dashboard call. It runs
// LAST and is the only authed pause/resume in the file, so the shared 'global' DO's
// `toggle` window starts cold here (the two `it`s run in order within the same
// sub-100ms run, so the second is inside the first's 5s window).
describe('entry router — DO inline routes (pause/resume): verbatim forward + coalesce', () => {
  const DASH_ORIGIN = 'https://dashboard.test.invalid';

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  it('pause (first in the window) delivers inline + forwards the dashboard 200 body VERBATIM', async () => {
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/pause', method: 'POST' })
      .reply(200, { ok: true, paused: true });

    const res = await SELF.fetch(`${BASE}/music/pause`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paused: true });
  });

  it('resume immediately after is coalesced by the throttle window: synthetic 200, NO dashboard call', async () => {
    // No interceptor queued — the request must NOT reach the dashboard (the toggle
    // window is still hot from the pause above). disableNetConnect would error on any
    // outbound call, and assertNoPendingInterceptors confirms none was expected.
    const res = await SELF.fetch(`${BASE}/music/resume`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, executed: false, coalesced: true });
  });
});
