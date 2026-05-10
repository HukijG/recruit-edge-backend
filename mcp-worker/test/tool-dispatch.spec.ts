import { describe, it, expect, vi, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index.js";
import { setupJwtFixture } from "./jwt-fixture.js";

const EMPTY_CTX = {} as ExecutionContext;
const TEST_EMAIL = "joel@test.local";

let makeJwt: Awaited<ReturnType<typeof setupJwtFixture>>["makeJwt"];

beforeAll(async () => {
  ({ makeJwt } = await setupJwtFixture());
});

function rpc(method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

async function authedRequest(body: string): Promise<Request> {
  const jwt = await makeJwt({ email: TEST_EMAIL, sub: "user-1" });
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Cf-Access-Jwt-Assertion": jwt,
    },
    body,
  });
}

async function parseRpcResponse(res: Response): Promise<{ result?: unknown; error?: unknown }> {
  const text = await res.text();
  const dataLines = text.split("\n").filter(l => l.startsWith("data: "));
  const lastJson = dataLines.length > 0 ? dataLines[dataLines.length - 1].slice(6) : text;
  return JSON.parse(lastJson);
}

async function callTool(
  testEnv: typeof env,
  toolName: string,
  args: Record<string, unknown> = {},
) {
  // MCP requires initialize before tools/call.
  await worker.fetch(
    await authedRequest(rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    })),
    testEnv,
    EMPTY_CTX,
  );
  return worker.fetch(
    await authedRequest(rpc("tools/call", { name: toolName, arguments: args })),
    testEnv,
    EMPTY_CTX,
  );
}

describe("tool dispatch", () => {
  it("rf_cache_status calls /mcp/cache-status with consultantEmail in body", async () => {
    const middlewareFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, candidates: 0, last_sync_at: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const testEnv = { ...env, MIDDLEWARE: { fetch: middlewareFetch } as unknown as Fetcher };

    const res = await callTool(testEnv, "rf_cache_status");
    expect(res.status).toBe(200);

    expect(middlewareFetch).toHaveBeenCalled();
    const [calledUrl, calledInit] = middlewareFetch.mock.calls.at(-1)!;
    expect(String(calledUrl)).toBe("https://internal/mcp/cache-status");
    expect(calledInit.method).toBe("POST");

    // Service-binding traffic no longer carries X-MCP-Token.
    expect(calledInit.headers["X-MCP-Token"]).toBeUndefined();

    const sentBody = JSON.parse(calledInit.body as string);
    // Email is extracted from the Access JWT claims.
    expect(sentBody.consultantEmail).toBe(TEST_EMAIL);
    // Old field must not be present.
    expect(sentBody.consultantFirstName).toBeUndefined();

    // Verify the worker's response body actually carries the middleware payload
    // back through respond() to the caller. The MCP transport may emit SSE-framed
    // (data: ...) lines or plain JSON depending on the Accept header negotiation.
    const payload = await parseRpcResponse(res);
    const innerText = (payload.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    expect(innerText).toBeDefined();
    expect(JSON.parse(innerText!)).toEqual({ ok: true, candidates: 0, last_sync_at: null });
  });

  it("MwClientError from middleware surfaces as isError tool result with status snippet", async () => {
    // Middleware returns a 500 with a body — guarded() should catch the throw
    // and return a fail() result containing the status code and body snippet.
    const middlewareFetch = vi.fn().mockResolvedValue(
      new Response("internal middleware crash detail", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const testEnv = { ...env, MIDDLEWARE: { fetch: middlewareFetch } as unknown as Fetcher };

    const res = await callTool(testEnv, "rf_cache_status");
    // The transport-level response is still 200 — MCP wraps tool errors in the
    // JSON-RPC envelope, not at HTTP layer.
    expect(res.status).toBe(200);

    const payload = await parseRpcResponse(res);
    const result = payload.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result?.isError).toBe(true);
    const errorText = result?.content?.[0]?.text;
    expect(errorText).toMatch(/Middleware error \(HTTP 500\)/);
    expect(errorText).toContain("internal middleware crash detail");
  });

  it("tools/list returns all 8 tools", async () => {
    const middlewareFetch = vi.fn();
    const testEnv = { ...env, MIDDLEWARE: { fetch: middlewareFetch } as unknown as Fetcher };

    await worker.fetch(
      await authedRequest(rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" },
      })),
      testEnv,
      EMPTY_CTX,
    );
    const res = await worker.fetch(
      await authedRequest(rpc("tools/list")),
      testEnv,
      EMPTY_CTX,
    );
    expect(res.status).toBe(200);

    // Streamable HTTP responses can be SSE-framed; parse the data line(s).
    const payload = await parseRpcResponse(res);
    const toolNames = (
      (payload.result as { tools?: Array<{ name: string }> })?.tools ?? []
    ).map((t) => t.name);

    expect(toolNames.sort()).toEqual([
      "rf_cache_status",
      "rf_candidate_add_note",
      "rf_candidate_get",
      "rf_candidate_log_interview",
      "rf_candidate_move_stage",
      "rf_candidate_search",
      "rf_job_candidates_filter",
      "rf_job_pipeline",
    ]);
  });
});
