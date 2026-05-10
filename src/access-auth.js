import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';

let jwks = null;

/**
 * verifyAccessJwt — validate a Cloudflare Access-issued JWT.
 *
 * Reads `Cf-Access-Jwt-Assertion` header (set by Access edge) first; falls
 * back to `Authorization: Bearer <token>` (used by the extension path in Spec B).
 * Verifies signature against Access's JWKS, plus issuer + audience claims.
 *
 * Algorithm allow-list is locked to RS256 (defense against algorithm-confusion
 * attacks where a token signed with the public key as an HS256 secret would
 * otherwise verify against the same key material).
 *
 * @param {Request} request
 * @param {{ ACCESS_TEAM_DOMAIN: string }} env
 * @param {string} expectedAud - 64-char hex Application Audience (AUD) tag from
 *   the Cloudflare Access dashboard. NOT a URL or redirect URI. JWTs minted for
 *   a different App's audience will be silently rejected (this is the
 *   audience-binding contract that prevents token reuse across resources).
 * @returns {Promise<{ email: string, sub: string } | null>}
 */
export async function verifyAccessJwt(request, env, expectedAud) {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const token = assertion ?? bearer;
  if (!token) return null;

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: expectedAud,
      algorithms: ['RS256'],
    });
    if (typeof payload.email !== 'string' || typeof payload.sub !== 'string') return null;
    if (payload.email.length === 0 || payload.sub.length === 0) return null;
    return { email: payload.email.toLowerCase(), sub: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Test-only: replace the JWKS source with a static key set, or pass `null`
 * to reset back to the remote JWKS lookup. Tests that stub the JWKS should
 * reset in `afterAll` if other suites in the same run depend on the real
 * remote source.
 *
 * @param {{ keys: object[] } | null} jwkSet
 */
export function _setJwksForTests(jwkSet) {
  // == null catches both null and undefined — defensive against an accidental
  // _setJwksForTests() with no args, which would otherwise crash inside
  // createLocalJWKSet(undefined) with a confusing "JWK Set malformed" error.
  jwks = jwkSet == null ? null : createLocalJWKSet(jwkSet);
}
