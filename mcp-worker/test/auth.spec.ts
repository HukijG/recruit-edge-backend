import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index.js";

const MCP_SECRET = "test-mcp-secret";

function makeRequest(opts: { token?: string; consultant?: string; method?: string; path?: string } = {}) {
  const { token, consultant, method = "POST", path = "/mcp" } = opts;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("X-MCP-Token", token);
  if (consultant !== undefined) headers.set("X-RF-Consultant", consultant);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) : undefined,
  });
}

describe("auth gate", () => {
  it("returns 401 when X-MCP-Token is missing", async () => {
    const res = await worker.fetch(makeRequest({ consultant: "Joel" }), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/X-MCP-Token/i);
  });

  it("returns 401 when X-MCP-Token is wrong", async () => {
    const res = await worker.fetch(
      makeRequest({ token: "wrong-secret", consultant: "Joel" }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when X-RF-Consultant is missing", async () => {
    const res = await worker.fetch(
      makeRequest({ token: MCP_SECRET }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toMatch(/X-RF-Consultant/i);
  });

  it("returns 400 when X-RF-Consultant is blank", async () => {
    const res = await worker.fetch(
      makeRequest({ token: MCP_SECRET, consultant: "   " }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 200 'ok' on GET /health regardless of headers", async () => {
    const res = await worker.fetch(
      makeRequest({ method: "GET", path: "/health" }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await worker.fetch(
      makeRequest({ method: "GET", path: "/nope" }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });
});
