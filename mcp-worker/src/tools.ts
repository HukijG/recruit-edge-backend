import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mwFetch, MwClientError } from "./mw-client.js";
import type { RequestCtx } from "./index.js";

const MAX_RESULT_CHARS = 140_000;

type ToolReturn = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function respond(value: unknown): ToolReturn {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  let truncated = false;
  if (text.length > MAX_RESULT_CHARS) {
    text = text.slice(0, MAX_RESULT_CHARS);
    truncated = true;
  }
  if (truncated) {
    text += `\n\n[truncated: response exceeded ${MAX_RESULT_CHARS} chars. Narrow the filter or pass a smaller "fields" projection.]`;
  }
  return { content: [{ type: "text", text }] };
}

function fail(msg: string): ToolReturn {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function guarded(fn: () => Promise<ToolReturn>): Promise<ToolReturn> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MwClientError) {
      return fail(`Middleware error (HTTP ${e.status}): ${e.bodyText.slice(0, 500)}`);
    }
    return fail(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerTools(server: McpServer, ctx: RequestCtx) {
  // ─── rf_cache_status ────────────────────────────────────────────────
  server.registerTool(
    "rf_cache_status",
    {
      title: "Cache freshness diagnostic (read-only)",
      description: [
        "Returns counts and last-sync timestamps for the server-side D1 cache. Does NOT trigger a refresh — sync runs server-side every 15 min.",
        "",
        "Use ONLY when the user questions data freshness or asks about the cache directly. Don't preempt-call before normal reads.",
      ].join("\n"),
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/cache-status", {});
        return respond(data);
      }),
  );
}
