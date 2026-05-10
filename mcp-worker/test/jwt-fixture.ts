/**
 * Shared JWT-minting fixture for mcp-worker tests.
 *
 * Call `setupJwtFixture()` in a `beforeAll` block. It generates an RSA key pair,
 * injects the public key into `access-auth.ts` via `_setJwksForTests`, and returns
 * `makeJwt` plus `publicJwk` (for tests that need to re-inject after a reset).
 *
 * The returned `makeJwt(claims, opts?)` accepts optional `aud` / `iss` overrides
 * so negative-path tests (wrong audience, wrong issuer) can use the same fixture.
 *
 * Usage:
 *   const { makeJwt } = await setupJwtFixture();
 *   const jwt = await makeJwt({ email: "joel@test.local", sub: "user-1" });
 *   const wrongAud = await makeJwt({ email: "...", sub: "..." }, { aud: "wrong" });
 */
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { env } from "cloudflare:test";
import { _setJwksForTests } from "../src/access-auth.js";

export type JwtClaims = Record<string, unknown>;
export interface JwtOpts {
  aud?: string;
  iss?: string;
}

export interface JwtFixture {
  makeJwt: (claims: JwtClaims, opts?: JwtOpts) => Promise<string>;
  publicJwk: JWK;
}

export async function setupJwtFixture(): Promise<JwtFixture> {
  const kp = await generateKeyPair("RS256", { extractable: true });
  const privateKey = kp.privateKey;
  const publicJwk: JWK = await exportJWK(kp.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  _setJwksForTests({ keys: [publicJwk] });

  async function makeJwt(claims: JwtClaims, opts: JwtOpts = {}): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(opts.iss ?? env.ACCESS_TEAM_DOMAIN)
      .setAudience(opts.aud ?? env.ACCESS_AUD_MCP)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  return { makeJwt, publicJwk };
}
