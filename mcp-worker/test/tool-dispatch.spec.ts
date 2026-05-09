import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index.js";

const MCP_SECRET = "test-mcp-secret";
const EMPTY_CTX = {} as ExecutionContext;

function rpc(method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

function authedRequest(body: string) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-MCP-Token": MCP_SECRET,
      "X-RF-Consultant": "Joel",
    },
    body,
  });
}

async function callTool(testEnv: typeof env, toolName: string, args: Record<string, unknown> = {}) {
  // MCP requires initialize before tools/call.
  await worker.fetch(
    authedRequest(rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    })),
    testEnv,
    EMPTY_CTX,
  );
  return worker.fetch(
    authedRequest(rpc("tools/call", { name: toolName, arguments: args })),
    testEnv,
    EMPTY_CTX,
  );
}

describe("tool dispatch", () => {
  it("rf_cache_status calls /mcp/cache-status with consultantFirstName in body", async () => {
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
    expect(calledInit.headers["X-MCP-Token"]).toBe(MCP_SECRET);
    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody.consultantFirstName).toBe("Joel");

    // Verify the worker's response body actually carries the middleware payload
    // back through respond() to the caller. The MCP transport may emit SSE-framed
    // (data: ...) lines or plain JSON depending on the Accept header negotiation.
    const text = await res.text();
    const dataLines = text.split("\n").filter(l => l.startsWith("data: "));
    const lastJson = dataLines.length > 0 ? dataLines[dataLines.length - 1].slice(6) : text;
    const payload = JSON.parse(lastJson);
    const innerText = payload.result?.content?.[0]?.text;
    expect(innerText).toBeDefined();
    expect(JSON.parse(innerText)).toEqual({ ok: true, candidates: 0, last_sync_at: null });
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

    const text = await res.text();
    const dataLines = text.split("\n").filter(l => l.startsWith("data: "));
    const lastJson = dataLines.length > 0 ? dataLines[dataLines.length - 1].slice(6) : text;
    const payload = JSON.parse(lastJson);
    const result = payload.result;
    expect(result?.isError).toBe(true);
    const errorText = result?.content?.[0]?.text;
    expect(errorText).toMatch(/Middleware error \(HTTP 500\)/);
    expect(errorText).toContain("internal middleware crash detail");
  });
});
