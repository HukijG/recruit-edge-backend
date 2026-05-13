import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { _setJwksForTests } from '../../src/access-auth.js';

let privateKey = null;
let publicJwk = null;

export async function ensureAccessJwksFixture() {
  if (privateKey) return;
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  _setJwksForTests({ keys: [publicJwk] });
}

// Defaults match the SaaS-OIDC shape production App 2 actually issues:
//   iss = <team_domain>/cdn-cgi/access/sso/oidc/<client_id>
//   aud = the first registered redirect URI from ACCESS_AUD_MIDDLEWARE (comma-separated)
// Callers override iss / aud explicitly to exercise mismatch paths or App 1 shape.
export async function mintAccessJwt(env, { email, sub = 'oidc-test', aud, iss } = {}) {
  if (!privateKey) throw new Error('Call ensureAccessJwksFixture() in beforeAll first');
  const defaultAud = env.ACCESS_AUD_MIDDLEWARE.split(',')[0].trim();
  const defaultIss = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID_MIDDLEWARE}`;
  return new SignJWT({ email, sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss ?? defaultIss)
    .setAudience(aud ?? defaultAud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
