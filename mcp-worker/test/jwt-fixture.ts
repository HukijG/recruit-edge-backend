/**
 * Shared JWT-minting fixture for mcp-worker tests.
 *
 * Call `setupJwtFixture()` in a `beforeAll` block. It generates an RSA key pair,
 * injects the public key into `access-auth.ts` via `_setJwksForTests`, and returns
 * `makeJwt` — a function that signs a JWT with the correct issuer/audience/claims.
 *
 * Usage:
 *   const { makeJwt } = await setupJwtFixture();
 *   const jwt = await makeJwt({ email: "joel@test.local", sub: "user-1" });
 */
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { env } from "cloudflare:test";
import { _setJwksForTests } from "../src/access-auth.js";

export type JwtClaims = Record<string, unknown>;

export interface JwtFixture {
  makeJwt: (claims: JwtClaims, aud?: string) => Promise<string>;
}

export async function setupJwtFixture(): Promise<JwtFixture> {
  const kp = await generateKeyPair("RS256", { extractable: true });
  const privateKey = kp.privateKey;
  const publicJwk: JWK = await exportJWK(kp.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  _setJwksForTests({ keys: [publicJwk] });

  async function makeJwt(claims: JwtClaims, aud: string = env.ACCESS_AUD_MCP): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(env.ACCESS_TEAM_DOMAIN)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  return { makeJwt };
}
