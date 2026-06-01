import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { verifyAccessJwt, _setJwksForTests, _MODULE_ID } from '../src/access-auth.js';
import { setupJwtFixture, app2Issuer, app2PrimaryAud } from './jwt-fixture.js';

describe('access-auth (music-worker)', () => {
  let makeJwt;

  beforeAll(async () => {
    ({ makeJwt } = await setupJwtFixture());
  });

  afterAll(() => {
    _setJwksForTests(null);
  });

  it('exposes the music-worker module-id sentinel (guards against resolver fallback)', () => {
    expect(_MODULE_ID).toBe('music-worker/access-auth');
  });

  function reqWithBearer(token) {
    return new Request('https://music.test/music/pause', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  const opts = () => ({
    issuer: app2Issuer(),
    jwksUrl: `${app2Issuer()}/jwks`,
  });

  it('validates an App-2 JWT (issuer + per-app JWKS + redirect-URI aud)', async () => {
    const jwt = await makeJwt({ email: 'joel@cognatio.test', sub: 'u-1' });
    const claims = await verifyAccessJwt(reqWithBearer(jwt), env, app2PrimaryAud(), opts());
    expect(claims).toEqual({ email: 'joel@cognatio.test', sub: 'u-1' });
  });

  it('accepts any of several registered redirect URIs (array aud)', async () => {
    const auds = env.ACCESS_AUD_MIDDLEWARE.split(',').map((s) => s.trim());
    const jwt = await makeJwt({ email: 'joel@cognatio.test', sub: 'u-1' }, { aud: auds[1] });
    const claims = await verifyAccessJwt(reqWithBearer(jwt), env, auds, opts());
    expect(claims?.email).toBe('joel@cognatio.test');
  });

  it('rejects a wrong-issuer token', async () => {
    const jwt = await makeJwt(
      { email: 'joel@cognatio.test', sub: 'u-1' },
      { iss: 'https://attacker.example/cdn-cgi/access/sso/oidc/x' },
    );
    const claims = await verifyAccessJwt(reqWithBearer(jwt), env, app2PrimaryAud(), opts());
    expect(claims).toBeNull();
  });

  it('rejects a wrong-audience token', async () => {
    const jwt = await makeJwt(
      { email: 'joel@cognatio.test', sub: 'u-1' },
      { aud: 'https://not-registered.chromiumapp.org/oauth-callback' },
    );
    const claims = await verifyAccessJwt(reqWithBearer(jwt), env, app2PrimaryAud(), opts());
    expect(claims).toBeNull();
  });

  it('lowercases the email claim', async () => {
    const jwt = await makeJwt({ email: 'JOEL@Cognatio.TEST', sub: 'u-1' });
    const claims = await verifyAccessJwt(reqWithBearer(jwt), env, app2PrimaryAud(), opts());
    expect(claims?.email).toBe('joel@cognatio.test');
  });

  it('returns null when no token is present', async () => {
    const req = new Request('https://music.test/music/pause', { method: 'POST' });
    const claims = await verifyAccessJwt(req, env, app2PrimaryAud(), opts());
    expect(claims).toBeNull();
  });
});
