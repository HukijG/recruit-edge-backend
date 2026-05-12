import { env as workerEnv } from "cloudflare:workers";
import { installBodyCapture } from "./lib/body-capture.js";
import { installLogsBridge } from "./lib/logs-bridge.js";

installBodyCapture();
installLogsBridge("rf-mcp-remote");

import { instrument } from "@microlabs/otel-cf-workers";
import { resolveOtelConfig } from "./lib/otel-config.js";
import { trace } from "@opentelemetry/api";
import { FLOWS } from "./lib/flow-names.js";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { verifyAccessJwt } from "./access-auth.js";

export interface Env {
  MIDDLEWARE: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD_MCP: string;
}

export interface RequestCtx {
  env: Env;
  consultantEmail: string;
}

function createServer(ctx: RequestCtx): McpServer {
  // Factory-per-request — required by MCP SDK >= 1.26.0 (CVE GHSA-345p-7cg4-v4c7).
  const server = new McpServer(
    { name: "rf-mcp", version: "0.7.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, ctx);
  return server;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const handler = {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      trace.getActiveSpan()?.setAttribute("flow.name", FLOWS.MCP_HEALTH);
      return new Response("ok", { status: 200 });
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    trace.getActiveSpan()?.setAttribute("flow.name", FLOWS.MCP_POST);

    const claims = await verifyAccessJwt(request, env, env.ACCESS_AUD_MCP);
    if (!claims) {
      return jsonResponse(401, { ok: false, error: "Invalid or missing Access JWT" });
    }

    trace.getActiveSpan()?.setAttribute("consultant.email", claims.email);

    // MCP worker does NOT read D1. Forward consultantEmail to middleware via
    // service binding; middleware does the email→user lookup.
    const consultantEmail = claims.email;

    const server = createServer({ env, consultantEmail });
    return createMcpHandler(server)(request, env, execCtx);
  },
} satisfies ExportedHandler<Env>;

// `instrument()` is the production wiring. In environments where `LD_SDK_KEY` is
// absent (e.g. the vitest harness), we export the raw handler so requests never
// touch the OTLP exporters. The lib `installLogsBridge` already self-skips on
// missing key; this mirrors that semantic at the handler layer. Same pattern as
// main + sync workers.
//
// `as typeof handler` retains the literal handler type for downstream consumers
// (tests import worker.fetch and call it with a DOM Request — the widened
// `ExportedHandler<Env>` type would over-constrain `request` to
// `IncomingRequestCfProperties` which test fixtures don't satisfy).
const exportedHandler = (workerEnv as unknown as { LD_SDK_KEY?: string }).LD_SDK_KEY
  ? (instrument(handler, resolveOtelConfig) as typeof handler)
  : handler;

export default exportedHandler;
