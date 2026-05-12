import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { JWK } from "jose";
import { verifyAccessJwt, _setJwksForTests, _MODULE_ID } from "../src/access-auth.js";
import { setupJwtFixture } from "./jwt-fixture.js";

let makeJwt: Awaited<ReturnType<typeof setupJwtFixture>>["makeJwt"];
let publicJwk: JWK;

beforeAll(async () => {
  // Phantom-resolution guard: vite's resolver will silently fall back to the
  // main worker's `src/access-auth.js` (one dir up) if this file disappears.
  // Asserting the sentinel makes that failure mode loud instead of silent.
  expect(_MODULE_ID).toBe("mcp-remote/access-auth");

  ({ makeJwt, publicJwk } = await setupJwtFixture());
});

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://x/mcp", { method: "POST", headers });
}

describe("verifyAccessJwt (mcp-remote)", () => {
  it("returns null when no header is present", async () => {
    const claims = await verifyAccessJwt(reqWith({}), env, env.ACCESS_AUD_MCP);
    expect(claims).toBeNull();
  });

  it("verifies a JWT in Cf-Access-Jwt-Assertion", async () => {
    const jwt = await makeJwt({ email: "JOEL@test.local", sub: "user-1" });
    const claims = await verifyAccessJwt(
      reqWith({ "Cf-Access-Jwt-Assertion": jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toEqual({ email: "joel@test.local", sub: "user-1" });
  });

  it("falls back to Authorization: Bearer", async () => {
    const jwt = await makeJwt({ email: "user2@test.local", sub: "user-2" });
    const claims = await verifyAccessJwt(
      reqWith({ Authorization: `Bearer ${jwt}` }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toMatchObject({ email: "user2@test.local" });
  });

  it("rejects wrong audience", async () => {
    const jwt = await makeJwt(
      { email: "joel@test.local", sub: "user-1" },
      { aud: "wrong-aud" },
    );
    const claims = await verifyAccessJwt(
      reqWith({ "Cf-Access-Jwt-Assertion": jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });

  it("rejects wrong issuer", async () => {
    const jwt = await makeJwt(
      { email: "joel@test.local", sub: "user-1" },
      { iss: "https://evil.example" },
    );
    const claims = await verifyAccessJwt(
      reqWith({ "Cf-Access-Jwt-Assertion": jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });

  it("rejects malformed token", async () => {
    const claims = await verifyAccessJwt(
      reqWith({ "Cf-Access-Jwt-Assertion": "not-a-jwt" }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });

  it("rejects when email or sub missing from claims", async () => {
    const jwt = await makeJwt({ email: "joel@test.local" }); // missing sub
    const claims = await verifyAccessJwt(
      reqWith({ "Cf-Access-Jwt-Assertion": jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
  });

  it("rejects empty-string email or sub even though typeof passes", async () => {
    // Empty strings satisfy `typeof === 'string'` but are not real claims.
    // Defense matches the D1 schema's `CHECK (email LIKE '%@%.%')` constraint
    // on the main worker side.
    const jwtEmptyEmail = await makeJwt({ email: "", sub: "user-1" });
    expect(
      await verifyAccessJwt(
        reqWith({ "Cf-Access-Jwt-Assertion": jwtEmptyEmail }),
        env,
        env.ACCESS_AUD_MCP,
      ),
    ).toBeNull();

    const jwtEmptySub = await makeJwt({ email: "joel@test.local", sub: "" });
    expect(
      await verifyAccessJwt(
        reqWith({ "Cf-Access-Jwt-Assertion": jwtEmptySub }),
        env,
        env.ACCESS_AUD_MCP,
      ),
    ).toBeNull();
  });

  it("_setJwksForTests(null) resets to remote source", async () => {
    // After resetting, the next call falls through to createRemoteJWKSet(URL),
    // which on the test domain (https://test.cloudflareaccess.com) will fail
    // to fetch keys. The token validation will throw inside jose; the helper
    // catches and returns null. This proves the reset path took effect — if
    // the local JWKS were still wired, a malformed token would also return
    // null but for a different reason. The behavioral signal is that the
    // helper rebuilds rather than crashing on null jwks.
    _setJwksForTests(null);
    const jwt = await makeJwt({ email: "joel@test.local", sub: "user-1" });
    const claims = await verifyAccessJwt(
      reqWith({ "Cf-Access-Jwt-Assertion": jwt }),
      env,
      env.ACCESS_AUD_MCP,
    );
    expect(claims).toBeNull();
    // Restore the test JWKS so any tests that run after this one still work.
    _setJwksForTests({ keys: [publicJwk] });
  });
});
