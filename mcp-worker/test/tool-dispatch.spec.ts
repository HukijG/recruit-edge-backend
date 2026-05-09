import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index.js";

const MCP_SECRET = "test-mcp-secret";

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
    {} as ExecutionContext,
  );
  return worker.fetch(
    authedRequest(rpc("tools/call", { name: toolName, arguments: args })),
    testEnv,
    {} as ExecutionContext,
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
  });
});
