import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { authMusicRequest, _resetAudUnsetWarnForTests } from '../src/auth-music.js';
import { _setJwksForTests } from '../src/access-auth.js';
import { setupJwtFixture } from './jwt-fixture.js';

function bearerReq(token) {
  return new Request('https://music.test/music/pause', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}
function legacyReq(token) {
  const headers = {};
  if (token !== undefined) headers['X-Extension-Token'] = token;
  return new Request('https://music.test/music/pause', { method: 'POST', headers });
}

describe('authMusicRequest dual-auth matrix', () => {
  let makeJwt;

  beforeAll(async () => {
    ({ makeJwt } = await setupJwtFixture());
  });
  afterAll(() => {
    _setJwksForTests(null);
  });
  beforeEach(() => {
    _resetAudUnsetWarnForTests();
  });

  it('JWT path: valid token => ok source=jwt (JWT-ONLY, no registry lookup, any email authorized)', async () => {
    // A valid Access JWT is the authorization — there is NO USERS_DB lookup, so an
    // email that would not appear in any team registry is still authorized.
    const jwt = await makeJwt({ email: 'stranger@cognatio.test', sub: 'u-9' });
    const res = await authMusicRequest(bearerReq(jwt), env);
    expect(res.ok).toBe(true);
    expect(res.source).toBe('jwt');
    expect(res.email).toBe('stranger@cognatio.test');
    expect(res.sub).toBe('u-9');
    // No identity gate => no user record on the result.
    expect(res.user).toBeUndefined();
  });

  it('JWT path: present-but-INVALID token => 401 auth_jwt_invalid, NO fall-through to legacy', async () => {
    // A Bearer header that is not a valid JWT. Even with a valid legacy token also
    // present, presence of Authorization is intent to use the JWT path.
    const req = new Request('https://music.test/music/pause', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer not-a-real-jwt',
        'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
      },
    });
    const res = await authMusicRequest(req, env);
    expect(res).toMatchObject({ ok: false, status: 401, code: 'auth_jwt_invalid' });
  });

  it('legacy path: correct X-Extension-Token => ok source=legacy', async () => {
    const res = await authMusicRequest(legacyReq(env.LINKEDIN_EXTENSION_SECRET), env);
    expect(res).toMatchObject({ ok: true, source: 'legacy' });
  });

  it('legacy path: wrong X-Extension-Token => 401 auth_legacy_invalid', async () => {
    const res = await authMusicRequest(legacyReq('wrong-secret'), env);
    expect(res).toMatchObject({ ok: false, status: 401, code: 'auth_legacy_invalid' });
  });

  it('no headers at all => 401 auth_missing', async () => {
    const res = await authMusicRequest(legacyReq(undefined), env);
    expect(res).toMatchObject({ ok: false, status: 401, code: 'auth_missing' });
  });

  it('fail-safe: JWT header present but ACCESS_CLIENT_ID_MIDDLEWARE empty => JWT skipped, legacy used', async () => {
    // Override env to blank the client id; with a valid legacy token also present,
    // the request should succeed via legacy (NOT silently accept the JWT with
    // audience:undefined).
    const patched = { ...env, ACCESS_CLIENT_ID_MIDDLEWARE: '' };
    const jwt = await makeJwt({ email: 'joel@cognatio.test', sub: 'u-1' });
    const req = new Request('https://music.test/music/pause', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
      },
    });
    const res = await authMusicRequest(req, patched);
    expect(res).toMatchObject({ ok: true, source: 'legacy' });
  });
});
