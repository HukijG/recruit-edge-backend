import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { API_REMOTE_PATH } from '../src/route-map.js';

// Integration tests for the entry router (src/index.js) — the seam where auth +
// route-map + proxy meet. The unit pieces are covered elsewhere; this file proves
// their COMPOSITION: auth ordering, the pre-auth WS branch, route/method mapping,
// per-kind body/query validation, the throwIfUnset -> 501 mapping, and the
// verbatim status+body pass-through of the dashboard Response.
//
// Auth: every /music/* route below uses the LEGACY X-Extension-Token path
// (LINKEDIN_EXTENSION_SECRET = 'test-extension-secret' in vitest.config.js), so
// the JWT/USERS_DB path is not exercised here (it is covered in auth-music.spec.js).

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

describe('entry router — routing, method, and placeholder mapping (authed)', () => {
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

  it('a known route whose dashboard sub-path is an unset placeholder -> 501 (escalation 1)', async () => {
    // /music/pause is a valid POST transport route, but API_REMOTE_PATH.pause is
    // a throw-if-unset placeholder, so the proxy step throws and maps to 501.
    const res = await SELF.fetch(`${BASE}/music/pause`, {
      method: 'POST',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/escalation 1/);
  });
});

// Inbound-request validation is this worker's OWN contract and runs BEFORE the
// outbound dashboard sub-path is resolved. So a malformed client request returns
// a 400 describing the client's error — NOT the 501 "escalation 1 / dashboard
// path unset" placeholder error, which is about the unfrozen outbound wiring and
// would mislead the client. These tests pin that ordering even while the
// dashboard sub-paths remain throw-if-unset placeholders.
describe('entry router — per-kind body/query validation (authed, runs before outbound-path resolution)', () => {
  it('volume with a missing/bad direction -> 400 (validation precedes the placeholder throw)', async () => {
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

// The proxy seam — exercised by TEMPORARILY wiring a real (non-placeholder)
// dashboard sub-path into the otherwise-frozen API_REMOTE_PATH, mocking the
// OUTBOUND fetch with `fetchMock` (the supported undici MockAgent — its
// responses are built inside the worker's request context, avoiding the
// cross-request-I/O error that a `vi.spyOn(globalThis,'fetch')` Response would
// hit under SELF.fetch), and restoring the placeholder afterward. This proves
// the router composes the correct dashboard request body + headers AND streams
// the dashboard Response status+body back verbatim — the half the unit tests
// (proxy.spec.js / route-map.spec.js) cannot cover.
describe('entry router — proxy composition + verbatim pass-through', () => {
  const DASH_ORIGIN = 'https://dashboard.test.local';

  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    // Assert every queued interceptor was consumed, then reset frozen placeholders.
    fetchMock.assertNoPendingInterceptors();
    API_REMOTE_PATH.volume = '__UNSET_volume__';
    API_REMOTE_PATH.play = '__UNSET_play__';
    API_REMOTE_PATH.search = '__UNSET_search__';
  });

  it('volume up -> proxies POST {delta:10} with X-Remote-Key, streams the dashboard 200 body verbatim', async () => {
    API_REMOTE_PATH.volume = '/api/remote/volume';
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
    expect(JSON.parse(seen.body)).toEqual({ delta: 10 });
    expect(headerOf(seen.headers, 'X-Remote-Key')).toBe('test-remote-key');
  });

  it('volume down -> proxies POST {delta:-10}', async () => {
    API_REMOTE_PATH.volume = '/api/remote/volume';
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

    expect(JSON.parse(seen.body)).toEqual({ delta: -10 });
  });

  it('play with a numeric-string id -> proxies POST {id:<number>} (coerced)', async () => {
    API_REMOTE_PATH.play = '/api/remote/play';
    let seen;
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/play', method: 'POST' })
      .reply((opts) => {
        seen = opts;
        return { statusCode: 200, data: {} };
      });

    await SELF.fetch(`${BASE}/music/play`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: '3135556' }),
    });

    expect(JSON.parse(seen.body)).toEqual({ id: 3135556 });
  });

  it('search -> GETs the dashboard with q encoded into the path, status + body passed through verbatim', async () => {
    API_REMOTE_PATH.search = '/api/remote/search';
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/search?q=daft%20punk', method: 'GET' })
      .reply(200, [], { headers: { 'Content-Type': 'application/json' } });

    const res = await SELF.fetch(`${BASE}/music/search?q=daft%20punk`, {
      method: 'GET',
      headers: authedHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('a non-200 dashboard response is streamed back verbatim (status + body)', async () => {
    API_REMOTE_PATH.play = '/api/remote/play';
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/play', method: 'POST' })
      .reply(503, { ok: false, error: 'deezer down' });

    const res = await SELF.fetch(`${BASE}/music/play`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: 42 }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'deezer down' });
  });

  it('a dashboard fetch rejection -> 502 dashboard_unreachable (structured, not an opaque 500)', async () => {
    API_REMOTE_PATH.play = '/api/remote/play';
    fetchMock
      .get(DASH_ORIGIN)
      .intercept({ path: '/api/remote/play', method: 'POST' })
      .replyWithError(new TypeError('Network connection lost'));

    const res = await SELF.fetch(`${BASE}/music/play`, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: 42 }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('dashboard_unreachable');
  });
});
