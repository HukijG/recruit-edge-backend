export interface Env {
  MIDDLEWARE: Fetcher;
  MCP_EXTENSION_SECRET: string;
}

export interface RequestCtx {
  env: Env;
  consultantFirstName: string;
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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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

    // MCP dispatch wired in Task 6.
    return jsonResponse(501, { ok: false, error: "MCP dispatch not yet wired" });
  },
} satisfies ExportedHandler<Env>;
