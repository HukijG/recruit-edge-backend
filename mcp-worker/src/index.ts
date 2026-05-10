import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

export interface Env {
  MIDDLEWARE: Fetcher;
  MCP_EXTENSION_SECRET: string;
  // Cloudflare Access — verified via verifyAccessJwt in src/access-auth.ts.
  // ACCESS_TEAM_DOMAIN is the team domain URL (e.g. https://acme.cloudflareaccess.com);
  // ACCESS_AUD_MCP is the 64-char hex Application Audience (AUD) tag from the
  // Access dashboard for the rf-mcp-remote app.
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD_MCP: string;
}

export interface RequestCtx {
  env: Env;
  consultantFirstName: string;
}

function createServer(ctx: RequestCtx): McpServer {
  // Factory-per-request — required by MCP SDK >= 1.26.0 (CVE GHSA-345p-7cg4-v4c7).
  // Do NOT hoist to module scope.
  const server = new McpServer(
    { name: "rf-mcp", version: "0.7.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, ctx);
  return server;
}

function timingSafeEqStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
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

    const token = request.headers.get("X-MCP-Token") ?? "";
    if (!token || !timingSafeEqStr(token, env.MCP_EXTENSION_SECRET)) {
      return jsonResponse(401, { ok: false, error: "Invalid or missing X-MCP-Token" });
    }

    const consultantFirstName = (request.headers.get("X-RF-Consultant") ?? "").trim();
    if (!consultantFirstName) {
      return jsonResponse(400, { ok: false, error: "Missing X-RF-Consultant header" });
    }

    const server = createServer({ env, consultantFirstName });
    return createMcpHandler(server)(request, env, execCtx);
  },
} satisfies ExportedHandler<Env>;
