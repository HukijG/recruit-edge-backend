import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';

// Test override: when set, `verifyAccessJwt` uses this JWKS regardless of `opts.jwksUrl`.
// Production cache: per-URL JWKS sources (App 1 / MCP uses the team-wide endpoint;
// App 2 / SaaS-OIDC uses a per-app `/sso/oidc/<client_id>/jwks`).
let testJwks = null;
const jwksByUrl = new Map();

function getJwks(jwksUrl) {
  if (testJwks) return testJwks;
  let entry = jwksByUrl.get(jwksUrl);
  if (!entry) {
    entry = createRemoteJWKSet(new URL(jwksUrl));
    jwksByUrl.set(jwksUrl, entry);
  }
  return entry;
}

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
 * Supports two token shapes via the optional `opts.issuer` override:
 *   - **Self-hosted + Managed OAuth** (App 1 / MCP — default): `iss` = team domain,
 *     `aud` = 64-char hex Application Audience (AUD) tag from the Access dashboard.
 *   - **SaaS-OIDC** (App 2 / extension): caller passes
 *     `opts.issuer = "<team_domain>/cdn-cgi/access/sso/oidc/<client_id>"`,
 *     `opts.jwksUrl = "<team_domain>/cdn-cgi/access/sso/oidc/<client_id>/jwks"`, and
 *     `expectedAud` = the registered redirect URI(s) (Cloudflare puts the redirect
 *     URI in the access_token's `aud` claim — not the client_id, not an AUD tag).
 *     Cloudflare uses PER-APP signing keys for SaaS-OIDC, so the team-wide JWKS
 *     does NOT contain the App 2 keys — the per-app JWKS endpoint is required.
 *
 * @param {Request} request
 * @param {{ ACCESS_TEAM_DOMAIN: string }} env
 * @param {string | string[]} expectedAud - audience to require. Pass an array to
 *   accept any of several values (e.g., multiple registered redirect URIs).
 * @param {{ issuer?: string, jwksUrl?: string }} [opts] - issuer + JWKS-source
 *   overrides. Defaults match App 1 / MCP shape (team-wide endpoint).
 * @returns {Promise<{ email: string, sub: string } | null>}
 */
export async function verifyAccessJwt(request, env, expectedAud, opts = {}) {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const token = assertion ?? bearer;
  if (!token) return null;

  const jwksUrl = opts.jwksUrl ?? `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const jwks = getJwks(jwksUrl);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: opts.issuer ?? env.ACCESS_TEAM_DOMAIN,
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
 * to reset back to per-URL remote JWKS lookup. While set, the test override
 * is returned regardless of `opts.jwksUrl` — so a single fixture key validates
 * both App 1 (default URL) and App 2 (per-app URL) tokens in tests. Tests
 * that stub the JWKS should reset in `afterAll` if other suites in the same
 * run depend on the real remote source.
 *
 * @param {{ keys: object[] } | null} jwkSet
 */
export function _setJwksForTests(jwkSet) {
  // == null catches both null and undefined — defensive against an accidental
  // _setJwksForTests() with no args, which would otherwise crash inside
  // createLocalJWKSet(undefined) with a confusing "JWK Set malformed" error.
  testJwks = jwkSet == null ? null : createLocalJWKSet(jwkSet);
}
