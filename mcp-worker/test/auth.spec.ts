import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { _setJwksForTests } from "../src/access-auth.js";
import worker from "../src/index.js";

let privateKey: CryptoKey;
let publicJwk: JWK;
const EMPTY_CTX = {} as ExecutionContext;
type ErrorBody = { ok: boolean; error: string };
type JwtClaims = Record<string, unknown>;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  _setJwksForTests({ keys: [publicJwk] });
});

async function makeJwt(claims: JwtClaims, aud = env.ACCESS_AUD_MCP): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(env.ACCESS_TEAM_DOMAIN)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function makeRequest(headers: Record<string, string>, method = "POST", path = "/mcp"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) : undefined,
  });
}

describe("auth gate (Access JWT)", () => {
  it("returns 401 with no JWT header", async () => {
    const res = await worker.fetch(makeRequest({}), env, EMPTY_CTX);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Access JWT/i);
  });

  it("returns 401 with malformed JWT in Cf-Access-Jwt-Assertion", async () => {
    const res = await worker.fetch(
      makeRequest({ "Cf-Access-Jwt-Assertion": "garbage" }),
      env,
      EMPTY_CTX,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for JWT with wrong audience", async () => {
    const jwt = await makeJwt({ email: "joel@test.local", sub: "user-1" }, "wrong-aud");
    const res = await worker.fetch(
      makeRequest({ "Cf-Access-Jwt-Assertion": jwt }),
      env,
      EMPTY_CTX,
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 ok on /health regardless of headers", async () => {
    const res = await worker.fetch(makeRequest({}, "GET", "/health"), env, EMPTY_CTX);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await worker.fetch(makeRequest({}, "GET", "/nope"), env, EMPTY_CTX);
    expect(res.status).toBe(404);
  });
});
