import { trace } from '@opentelemetry/api';
import { verifyAccessJwt } from './access-auth.js';
import { getUserByEmail } from './users.js';

let audUnsetWarned = false;

/**
 * Dual-auth gate for every user-facing route on the main worker.
 *
 * Order:
 *   1. If both ACCESS_AUD_MIDDLEWARE and ACCESS_CLIENT_ID_MIDDLEWARE are configured AND the
 *      request carries Authorization: Bearer or Cf-Access-Jwt-Assertion → attempt JWT
 *      verification. A valid JWT with an unknown email returns 403 (not 401) so the
 *      extension can distinguish "you're authenticated but not in the team registry" from
 *      "your token expired".
 *   2. A present-but-INVALID JWT returns 401 auth_jwt_invalid; we do NOT fall through to
 *      legacy. Presence of Authorization: Bearer is intent to use the JWT path.
 *   3. Otherwise read X-Extension-Token. Match against env.LINKEDIN_EXTENSION_SECRET; on
 *      success, return ok with source='legacy' and user=null — the handler reads
 *      body.consultantFirstName itself.
 *   4. No headers → 401 auth_missing.
 *
 * SaaS-OIDC token shape (App 2): Cloudflare Access SaaS-OIDC apps issue access_tokens
 * with `iss = <team_domain>/cdn-cgi/access/sso/oidc/<client_id>` and `aud = <redirect URI>`
 * (the registered chromiumapp.org callback — not an AUD tag, not the client_id). Both
 * env vars are required to construct the issuer URL and the accepted audience set;
 * ACCESS_AUD_MIDDLEWARE supports comma-separated values so multiple Chrome profiles /
 * dev builds can register additional redirect URIs without code changes.
 *
 * Fail-safe: if EITHER env var is unset/empty, the JWT branch is skipped entirely.
 * Without this, jose.jwtVerify with `audience: undefined` would not validate audience —
 * letting an App 1 (MCP) token authenticate against the middleware.
 *
 * @param {Request} request
 * @param {{ ACCESS_TEAM_DOMAIN: string, ACCESS_AUD_MIDDLEWARE?: string, ACCESS_CLIENT_ID_MIDDLEWARE?: string, LINKEDIN_EXTENSION_SECRET?: string }} env
 * @returns {Promise<
 *   | { ok: true, source: 'jwt', user: object, email: string }
 *   | { ok: true, source: 'legacy', user: null }
 *   | { ok: false, status: 401 | 403, code: 'auth_missing' | 'auth_legacy_invalid' | 'auth_jwt_invalid' | 'auth_jwt_unknown_email', message: string }
 * >}
 */
export async function authExtensionRequest(request, env) {
  const audRaw = typeof env.ACCESS_AUD_MIDDLEWARE === 'string' ? env.ACCESS_AUD_MIDDLEWARE.trim() : '';
  const clientId =
    typeof env.ACCESS_CLIENT_ID_MIDDLEWARE === 'string' ? env.ACCESS_CLIENT_ID_MIDDLEWARE.trim() : '';
  const audList = audRaw ? audRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const jwtPathReady = audList.length > 0 && clientId.length > 0;
  const hasJwtHeader =
    !!request.headers.get('Authorization') || !!request.headers.get('Cf-Access-Jwt-Assertion');

  if (jwtPathReady && hasJwtHeader) {
    const issuer = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${clientId}`;
    const expectedAud = audList.length === 1 ? audList[0] : audList;
    const claims = await verifyAccessJwt(request, env, expectedAud, { issuer });
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
    return { ok: true, source: 'jwt', user, email: claims.email };
  }

  if (!jwtPathReady && hasJwtHeader && !audUnsetWarned) {
    audUnsetWarned = true;
    console.warn({
      source: 'auth',
      message:
        '[auth] ACCESS_AUD_MIDDLEWARE and/or ACCESS_CLIENT_ID_MIDDLEWARE not configured — JWT path skipped, falling through to legacy',
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
 * Stamp success-path span attributes. Call from every handler immediately after
 * authExtensionRequest returns ok=true. The handler stamps consultant.first_name
 * separately AFTER resolving it (legacy path resolves after reading body).
 */
export function setAuthSpanSuccess(auth) {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('auth.source', auth.source);
  span.setAttribute('auth.outcome', 'ok');
  if (auth.source === 'jwt') {
    span.setAttribute('consultant.email', auth.email);
    if (auth.user?.firstName) {
      span.setAttribute('consultant.first_name', auth.user.firstName);
    }
  }
}

/**
 * Stamp failure-path span attributes. Call from every handler when
 * authExtensionRequest returns ok=false, before returning the Response.
 */
export function setAuthSpanFailure(auth) {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('auth.outcome', auth.code);
}

/**
 * Test-only: reset the one-shot AUD-unset warning flag so each test starts clean.
 */
export function _resetAudUnsetWarnForTests() {
  audUnsetWarned = false;
}
