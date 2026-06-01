import { verifyAccessJwt } from './access-auth.js';
import { getUserByEmail } from './users-d1-read.js';

// TRIMMED copy of the MAIN worker src/auth-extension.js `authExtensionRequest`.
// DROPS ONLY the OTel surface (`import { trace }` + the setAuthSpan* stampers).
// KEEPS every load-bearing guard verbatim:
//   (a) jwtPathReady fail-safe — if EITHER ACCESS_AUD_MIDDLEWARE or
//       ACCESS_CLIENT_ID_MIDDLEWARE is unset/empty, skip the JWT branch and fall
//       through to legacy. (Without this, jose.jwtVerify with audience:undefined
//       would not validate audience, letting an App-1 / MCP token authenticate.)
//   (b) present-but-INVALID JWT => 401 auth_jwt_invalid, do NOT fall through
//       (presence of Authorization/Cf-Access-Jwt-Assertion is intent to use JWT).
//   (c) JWT identity gate — valid JWT with an unknown email => 403
//       auth_jwt_unknown_email (distinguishes "authenticated but not in the team
//       registry" from "token expired"). Resolved via the read-only USERS_DB
//       getUserByEmail, NOT a parallel email allowlist.
//   (d) legacy fallback = X-Extension-Token vs env.LINKEDIN_EXTENSION_SECRET.
//
// The JWT branch reverses the original brief's "drop getUserByEmail" instruction
// on purpose: dropping the identity gate would let ANY valid SaaS-OIDC team token
// control the LIVE music remote — strictly weaker than the existing extension
// scheme the frozen contract says to reuse. See docs/music-worker.md + escalation 2.

let audUnsetWarned = false;

/**
 * Dual-auth gate for every /music/* endpoint + the WS-ticket-issue endpoint.
 *
 * @param {Request} request
 * @param {{ ACCESS_TEAM_DOMAIN: string, ACCESS_AUD_MIDDLEWARE?: string, ACCESS_CLIENT_ID_MIDDLEWARE?: string, LINKEDIN_EXTENSION_SECRET?: string, USERS_DB: D1Database }} env
 * @returns {Promise<
 *   | { ok: true, source: 'jwt', user: object, email: string, sub: string }
 *   | { ok: true, source: 'legacy', user: null }
 *   | { ok: false, status: 401 | 403, code: 'auth_missing' | 'auth_legacy_invalid' | 'auth_jwt_invalid' | 'auth_jwt_unknown_email', message: string }
 * >}
 */
export async function authMusicRequest(request, env) {
  const audRaw = typeof env.ACCESS_AUD_MIDDLEWARE === 'string' ? env.ACCESS_AUD_MIDDLEWARE.trim() : '';
  const clientId =
    typeof env.ACCESS_CLIENT_ID_MIDDLEWARE === 'string' ? env.ACCESS_CLIENT_ID_MIDDLEWARE.trim() : '';
  const audList = audRaw ? audRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const jwtPathReady = audList.length > 0 && clientId.length > 0;
  const hasJwtHeader =
    !!request.headers.get('Authorization') || !!request.headers.get('Cf-Access-Jwt-Assertion');

  if (jwtPathReady && hasJwtHeader) {
    const issuer = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${clientId}`;
    const jwksUrl = `${issuer}/jwks`;
    const expectedAud = audList.length === 1 ? audList[0] : audList;
    const claims = await verifyAccessJwt(request, env, expectedAud, { issuer, jwksUrl });
    if (!claims) {
      return {
        ok: false,
        status: 401,
        code: 'auth_jwt_invalid',
        message: 'Invalid or expired authentication token',
      };
    }
    const user = await getUserByEmail(env, claims.email);
    if (!user) {
      return {
        ok: false,
        status: 403,
        code: 'auth_jwt_unknown_email',
        message: 'Authenticated user is not registered in the team',
      };
    }
    return { ok: true, source: 'jwt', user, email: claims.email, sub: claims.sub };
  }

  if (!jwtPathReady && hasJwtHeader && !audUnsetWarned) {
    audUnsetWarned = true;
    console.warn({
      source: 'auth-music',
      message:
        '[auth-music] ACCESS_AUD_MIDDLEWARE and/or ACCESS_CLIENT_ID_MIDDLEWARE not configured — JWT path skipped, falling through to legacy',
    });
  }

  const legacyToken = request.headers.get('X-Extension-Token');
  if (!legacyToken) {
    return { ok: false, status: 401, code: 'auth_missing', message: 'Authentication required' };
  }
  if (!env.LINKEDIN_EXTENSION_SECRET || legacyToken !== env.LINKEDIN_EXTENSION_SECRET) {
    return { ok: false, status: 401, code: 'auth_legacy_invalid', message: 'Authentication failed' };
  }
  return { ok: true, source: 'legacy', user: null };
}

/**
 * Test-only: reset the one-shot AUD-unset warning flag so each test starts clean.
 */
export function _resetAudUnsetWarnForTests() {
  audUnsetWarned = false;
}
