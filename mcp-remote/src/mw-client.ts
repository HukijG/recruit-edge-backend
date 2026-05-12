/**
 * Thin client over the MIDDLEWARE service binding to the /mcp/* surface.
 *
 * Behaviour contract:
 *   - 4xx / 5xx → throws MwClientError (loud, install-shaped failures).
 *   - HTTP 200 with { ok: false, ... } body → passes through verbatim
 *     (recoverable conditions: needs_disambiguation, unknown stage, etc.).
 *   - Auth-derived consultantEmail always overrides any caller-supplied
 *     value in `body` — the Access JWT is the source of truth for identity.
 *   - No X-MCP-Token header: service-binding traffic is trust-local.
 *
 * Observability: stamps `mcp.tool.args` (request payload) on the active tool
 * span BEFORE the service-binding fetch, and `mcp.tool.result` (raw response
 * text, truncated) on the same span AFTER. This means every `MCP/rf_*` span
 * in LD shows its inputs and outputs as queryable attributes — no drilling
 * into the inner service-binding client span required.
 */
import { trace } from "@opentelemetry/api";
import type { RequestCtx } from "./index.js";

// Match the same cap respond() uses for the LLM-facing result string. Keeps
// the attribute query-friendly without trimming actual call payloads (which
// are bounded by the tools' own argument shapes).
const MAX_SPAN_VALUE_CHARS = 32 * 1024;

function truncateForAttr(value: string): string {
  if (value.length <= MAX_SPAN_VALUE_CHARS) return value;
  return value.slice(0, MAX_SPAN_VALUE_CHARS) + `…[truncated, original ${value.length} bytes]`;
}

function safeJsonStringify(value: unknown): string | null {
  try { return JSON.stringify(value); } catch { return null; }
}

export class MwClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    message: string,
  ) {
    super(message);
    this.name = "MwClientError";
  }
}

export async function mwFetch<T = unknown>(
  ctx: RequestCtx,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  // Service bindings dispatch by binding, not DNS — the hostname is conventional only.
  const url = "https://internal" + path;
  const payload = { ...body, consultantEmail: ctx.consultantEmail };

  // Stamp the resolved tool args (with the auth-derived consultantEmail in
  // place) onto the active tool span. Single source of truth for "what did
  // we just send to the middleware" in the trace UI.
  const argsSpan = trace.getActiveSpan();
  if (argsSpan) {
    try {
      const stringified = safeJsonStringify(payload);
      if (stringified !== null) argsSpan.setAttribute("mcp.tool.args", truncateForAttr(stringified));
    } catch { /* never throw on telemetry */ }
  }

  const res = await ctx.env.MIDDLEWARE.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  // Stamp the raw middleware response onto the tool span — same span as
  // above, since the fetch-child span ended when MIDDLEWARE.fetch resolved.
  // Outcome discriminator (`mcp.outcome.kind`) is filterable in LD for
  // health dashboards (e.g. "all 5xx", "all needs_disambiguation").
  const resultSpan = trace.getActiveSpan();
  if (resultSpan) {
    try {
      if (text) resultSpan.setAttribute("mcp.tool.result", truncateForAttr(text));
      resultSpan.setAttribute("mcp.middleware.status", res.status);
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          const p = parsed as Record<string, unknown>;
          if (p.needs_disambiguation === true) {
            resultSpan.setAttribute("mcp.outcome.kind", "needs_disambiguation");
          } else if (p.ok === false && typeof p.kind === "string") {
            resultSpan.setAttribute("mcp.outcome.kind", p.kind);
          } else if (p.ok === true) {
            resultSpan.setAttribute("mcp.outcome.kind", "ok");
          }
        }
      } catch { /* not JSON — skip outcome discriminator */ }
    } catch { /* never throw on telemetry */ }
  }

  if (!res.ok) {
    throw new MwClientError(
      res.status,
      text,
      `Middleware POST ${path} failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
    );
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
