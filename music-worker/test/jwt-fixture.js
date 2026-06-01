/**
 * Shared JWT-minting fixture for music-worker tests. Ported to JS from
 * mcp-remote/test/jwt-fixture.ts, but defaulting iss/aud to the App-2
 * (SaaS-OIDC) shape the extension actually uses — NOT the App-1 team-domain
 * shape — so the happy path exercises the real validator path.
 *
 * Call `setupJwtFixture()` in a `beforeAll`. It generates an RSA key pair, injects
 * the public key into access-auth.js via `_setJwksForTests`, and returns
 * `makeJwt` + `publicJwk`.
 *
 * `makeJwt(claims, opts?)` accepts optional `aud` / `iss` overrides so negative
 * tests (wrong audience, wrong issuer) reuse the fixture.
 */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { env } from 'cloudflare:test';
import { _setJwksForTests } from '../src/access-auth.js';

// App-2 issuer derived exactly as src/auth-music.js derives it.
export function app2Issuer() {
  return `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID_MIDDLEWARE}`;
}

// First registered redirect URI from the comma-separated ACCESS_AUD_MIDDLEWARE.
export function app2PrimaryAud() {
  return env.ACCESS_AUD_MIDDLEWARE.split(',')[0].trim();
}

export async function setupJwtFixture() {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const privateKey = kp.privateKey;
  const publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  _setJwksForTests({ keys: [publicJwk] });

  async function makeJwt(claims, opts = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.iss ?? app2Issuer())
      .setAudience(opts.aud ?? app2PrimaryAud())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  return { makeJwt, publicJwk };
}
