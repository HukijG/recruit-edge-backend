import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyAccessJwt, _setJwksForTests } from '../src/access-auth.js';

let privateKey;
let publicJwk;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  // Stub the helper's JWKS source so it returns our test key.
  _setJwksForTests({ keys: [publicJwk] });
});

async function makeJwt(claims, opts = {}) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(opts.iss ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(opts.aud ?? env.ACCESS_AUD_MCP)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function reqWith(headers) {
  return new Request('http://x/mcp', { method: 'POST', headers });
}

describe('verifyAccessJwt', () => {
  it('returns null when no header is present', async () => {
    const claims = await verifyAccessJwt(reqWith({}), env, env.ACCESS_AUD_MCP);
    expect(claims).toBeNull();
  });

  it('verifies a JWT in Cf-Access-Jwt-Assertion', async () => {
    const jwt = await makeJwt({ email: 'JOEL@test.local', sub: 'user-1' });
    const claims = await verifyAccessJwt(
      reqWith({ 'Cf-Access-Jwt-Assertion': jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toEqual({ email: 'joel@test.local', sub: 'user-1' });
  });

  it('falls back to Authorization: Bearer', async () => {
    const jwt = await makeJwt({ email: 'user2@test.local', sub: 'user-2' });
    const claims = await verifyAccessJwt(
      reqWith({ 'Authorization': `Bearer ${jwt}` }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toMatchObject({ email: 'user2@test.local' });
  });

  it('rejects wrong audience', async () => {
    const jwt = await makeJwt({ email: 'joel@test.local', sub: 'user-1' }, { aud: 'wrong-aud' });
    const claims = await verifyAccessJwt(
      reqWith({ 'Cf-Access-Jwt-Assertion': jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });

  it('rejects wrong issuer', async () => {
    const jwt = await makeJwt({ email: 'joel@test.local', sub: 'user-1' }, { iss: 'https://evil.example' });
    const claims = await verifyAccessJwt(
      reqWith({ 'Cf-Access-Jwt-Assertion': jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });

  it('rejects malformed token', async () => {
    const claims = await verifyAccessJwt(
      reqWith({ 'Cf-Access-Jwt-Assertion': 'not-a-jwt' }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });

  it('rejects when email or sub missing from claims', async () => {
    const jwt = await makeJwt({ email: 'joel@test.local' }); // missing sub
    const claims = await verifyAccessJwt(
      reqWith({ 'Cf-Access-Jwt-Assertion': jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });
});
