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

export async function mintAccessJwt(env, { email, sub = 'oidc-test', aud, iss } = {}) {
  if (!privateKey) throw new Error('Call ensureAccessJwksFixture() in beforeAll first');
  return new SignJWT({ email, sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(aud ?? env.ACCESS_AUD_MIDDLEWARE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
