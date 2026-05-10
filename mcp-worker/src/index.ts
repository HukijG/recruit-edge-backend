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

export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    const claims = await verifyAccessJwt(request, env, env.ACCESS_AUD_MCP);
    if (!claims) {
      return jsonResponse(401, { ok: false, error: "Invalid or missing Access JWT" });
    }

    // MCP worker does NOT read D1. Forward consultantEmail to middleware via
    // service binding; middleware does the email→user lookup.
    const consultantEmail = claims.email;

    const server = createServer({ env, consultantEmail });
    return createMcpHandler(server)(request, env, execCtx);
  },
} satisfies ExportedHandler<Env>;
