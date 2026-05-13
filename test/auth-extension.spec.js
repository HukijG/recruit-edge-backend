import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { _setJwksForTests } from '../src/access-auth.js';
import { authExtensionRequest, _resetAudUnsetWarnForTests } from '../src/auth-extension.js';
import { _resetCacheForTests } from '../src/users.js';
import { applyUsersMigration } from './helpers/users-migrate.js';

let privateKey;
let publicJwk;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  _setJwksForTests({ keys: [publicJwk] });
});

beforeEach(async () => {
  await applyUsersMigration(env);
  _resetCacheForTests();
  _resetAudUnsetWarnForTests();
});

// Default to the SaaS-OIDC shape that production App 2 actually issues:
//   iss = <team_domain>/cdn-cgi/access/sso/oidc/<client_id>
//   aud = registered redirect URI (first value in the comma-separated ACCESS_AUD_MIDDLEWARE)
// Callers can override iss / aud explicitly to exercise mismatch paths.
const DEFAULT_AUD = env.ACCESS_AUD_MIDDLEWARE.split(',')[0].trim();
const DEFAULT_ISS = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID_MIDDLEWARE}`;

async function mintJwt({ email = 'joel@test.local', sub = 'oidc-1', aud, iss, exp } = {}) {
  const jwt = new SignJWT({ email, sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss ?? DEFAULT_ISS)
    .setAudience(aud ?? DEFAULT_AUD)
    .setIssuedAt();
  if (exp !== undefined) {
    jwt.setExpirationTime(exp);
  } else {
    jwt.setExpirationTime('5m');
  }
  return jwt.sign(privateKey);
}

function reqWith(headers, path = '/candidates') {
  return new Request(`http://test.local${path}`, { method: 'POST', headers });
}

describe('authExtensionRequest — JWT path', () => {
  it('valid JWT + known email → ok=true, source=jwt, user populated', async () => {
    const jwt = await mintJwt({ email: 'joel@test.local' });
    const r = await authExtensionRequest(reqWith({ Authorization: `Bearer ${jwt}` }), env);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('jwt');
    expect(r.email).toBe('joel@test.local');
    expect(r.user).toBeTruthy();
    expect(r.user.firstName.toLowerCase()).toBe('joel');
    expect(r.sub).toBe('oidc-1');
  });

  it('valid JWT + unknown email → ok=false, status=403, code=auth_jwt_unknown_email', async () => {
    const jwt = await mintJwt({ email: 'stranger@elsewhere.test' });
    const r = await authExtensionRequest(reqWith({ Authorization: `Bearer ${jwt}` }), env);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.code).toBe('auth_jwt_unknown_email');
  });

  it('JWT with wrong audience → 401 auth_jwt_invalid (no fall-through to legacy)', async () => {
    const jwt = await mintJwt({ aud: 'not-the-middleware-aud' });
    const r = await authExtensionRequest(
      reqWith({
        Authorization: `Bearer ${jwt}`,
        'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET, // would succeed if fall-through
      }),
      env,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.code).toBe('auth_jwt_invalid');
  });

  it('JWT with wrong issuer → 401 auth_jwt_invalid', async () => {
    const jwt = await mintJwt({ iss: 'https://attacker.example' });
    const r = await authExtensionRequest(reqWith({ Authorization: `Bearer ${jwt}` }), env);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth_jwt_invalid');
  });

  it('expired JWT → 401 auth_jwt_invalid', async () => {
    const jwt = await mintJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const r = await authExtensionRequest(reqWith({ Authorization: `Bearer ${jwt}` }), env);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth_jwt_invalid');
  });

  it('mangled JWT signature → 401 auth_jwt_invalid (NOT fall-through to legacy)', async () => {
    const jwt = (await mintJwt()) + 'tamper';
    const r = await authExtensionRequest(
      reqWith({
        Authorization: `Bearer ${jwt}`,
        'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
      }),
      env,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.code).toBe('auth_jwt_invalid');
  });
});

describe('authExtensionRequest — legacy path', () => {
  it('valid X-Extension-Token only → ok=true, source=legacy, user=null', async () => {
    const r = await authExtensionRequest(
      reqWith({ 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET }),
      env,
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe('legacy');
    expect(r.user).toBeNull();
  });

  it('wrong X-Extension-Token → 401 auth_legacy_invalid', async () => {
    const r = await authExtensionRequest(reqWith({ 'X-Extension-Token': 'wrong' }), env);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.code).toBe('auth_legacy_invalid');
  });

  it('no auth headers at all → 401 auth_missing', async () => {
    const r = await authExtensionRequest(reqWith({}), env);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.code).toBe('auth_missing');
  });
});

describe('authExtensionRequest — dual-header precedence', () => {
  it('valid JWT + valid legacy header → JWT wins', async () => {
    const jwt = await mintJwt({ email: 'joel@test.local' });
    const r = await authExtensionRequest(
      reqWith({
        Authorization: `Bearer ${jwt}`,
        'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
      }),
      env,
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe('jwt');
  });

  it('valid JWT + WRONG legacy header → JWT still wins', async () => {
    const jwt = await mintJwt({ email: 'joel@test.local' });
    const r = await authExtensionRequest(
      reqWith({
        Authorization: `Bearer ${jwt}`,
        'X-Extension-Token': 'wrong',
      }),
      env,
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe('jwt');
  });
});

describe('authExtensionRequest — multi-redirect-URI accept', () => {
  it('JWT with secondary registered redirect URI as aud → ok=true, source=jwt', async () => {
    // ACCESS_AUD_MIDDLEWARE in vitest.config.js is comma-separated; both URIs must validate.
    const secondaryAud = env.ACCESS_AUD_MIDDLEWARE.split(',')[1].trim();
    const jwt = await mintJwt({ email: 'joel@test.local', aud: secondaryAud });
    const r = await authExtensionRequest(reqWith({ Authorization: `Bearer ${jwt}` }), env);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('jwt');
    expect(r.email).toBe('joel@test.local');
  });
});

describe('authExtensionRequest — fail-safe when SaaS-OIDC env vars unset', () => {
  it('AUD unset + MCP-shaped JWT → falls through to legacy (does NOT accept the JWT)', async () => {
    // Mint a JWT that looks like an App 1 (MCP) token: team-domain issuer + MCP AUD tag.
    // Strip ACCESS_AUD_MIDDLEWARE and assert the JWT is NOT silently accepted by the
    // middleware (defense against cross-app token reuse if the secret is misconfigured).
    const jwt = await mintJwt({ iss: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD_MCP });
    const envWithoutAud = { ...env, ACCESS_AUD_MIDDLEWARE: '' };
    const r = await authExtensionRequest(
      reqWith({ Authorization: `Bearer ${jwt}` }),
      envWithoutAud,
    );
    // No legacy header → falls through to auth_missing. JWT was NOT accepted.
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth_missing');
  });

  it('CLIENT_ID unset + valid SaaS-OIDC JWT → falls through to legacy (JWT path disabled)', async () => {
    // The second half of the fail-safe: even with the right audience, missing the client_id
    // means we can't construct the issuer URL — so the JWT path must skip rather than
    // accept tokens with a known-good aud but unchecked issuer.
    const jwt = await mintJwt();
    const envWithoutClientId = { ...env, ACCESS_CLIENT_ID_MIDDLEWARE: '' };
    const r = await authExtensionRequest(
      reqWith({ Authorization: `Bearer ${jwt}` }),
      envWithoutClientId,
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth_missing');
  });

  it('AUD unset + JWT + valid legacy header → legacy path succeeds (JWT skipped)', async () => {
    const jwt = await mintJwt();
    const envWithoutAud = { ...env, ACCESS_AUD_MIDDLEWARE: '' };
    const r = await authExtensionRequest(
      reqWith({
        Authorization: `Bearer ${jwt}`,
        'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
      }),
      envWithoutAud,
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe('legacy');
  });
});
