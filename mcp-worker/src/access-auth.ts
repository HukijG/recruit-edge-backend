import {
  jwtVerify,
  createRemoteJWKSet,
  createLocalJWKSet,
  type JWTPayload,
  type JSONWebKeySet,
} from "jose";

// jose's two factory functions return different concrete types but share the
// same call signature `(protectedHeader, token) => Promise<KeyLike>` that
// jwtVerify accepts. We retain the union here so the test reset path
// (`_setJwksForTests(null)`) can swap implementations cleanly without `any`.
type JwksGetter =
  | ReturnType<typeof createRemoteJWKSet>
  | ReturnType<typeof createLocalJWKSet>;

let jwks: JwksGetter | null = null;

/**
 * Module-id sentinel asserted by `mcp-worker/test/access-auth.spec.ts` to guard
 * against vite's relative-path resolver silently falling back to the main
 * worker's `src/access-auth.js` (one directory up from `mcp-worker/`) if this
 * file is ever absent or moved. Without this guard, deleting / renaming this
 * file leaves the test suite green while exercising a different module — a
 * silent regression vector that becomes load-bearing once T9+ diverges this
 * file's API from the main worker's. See T8 review.
 */
export const _MODULE_ID = "mcp-worker/access-auth";

/**
 * verifyAccessJwt — validate a Cloudflare Access-issued JWT.
 *
 * Reads `Cf-Access-Jwt-Assertion` header (set by Access edge) first; falls
 * back to `Authorization: Bearer <token>` (used by clients that can only set
 * Authorization, e.g. claude.ai's connector OAuth flow).
 *
 * Verifies signature against Access's JWKS, plus issuer + audience claims.
 *
 * Algorithm allow-list is locked to RS256 (defense against algorithm-confusion
 * attacks where a token signed with the public key as an HS256 secret would
 * otherwise verify against the same key material).
 *
 * @param expectedAud - 64-char hex Application Audience (AUD) tag from the
 *   Cloudflare Access dashboard. NOT a URL or redirect URI. JWTs minted for a
 *   different App's audience are silently rejected (this is the audience-binding
 *   contract that prevents token reuse across resources).
 */
export async function verifyAccessJwt(
  request: Request,
  env: { ACCESS_TEAM_DOMAIN: string },
  expectedAud: string,
): Promise<{ email: string; sub: string } | null> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const bearer =
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const token = assertion ?? bearer;
  if (!token) return null;

  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
    );
  }

  try {
    const { payload }: { payload: JWTPayload } = await jwtVerify(token, jwks, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: expectedAud,
      algorithms: ["RS256"],
    });
    if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
      return null;
    }
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
 */
export function _setJwksForTests(jwkSet: JSONWebKeySet | null): void {
  // == null catches both null and undefined — defensive against an accidental
  // _setJwksForTests() with no args, which would otherwise crash inside
  // createLocalJWKSet(undefined) with a confusing "JWK Set malformed" error.
  jwks = jwkSet == null ? null : createLocalJWKSet(jwkSet);
}
