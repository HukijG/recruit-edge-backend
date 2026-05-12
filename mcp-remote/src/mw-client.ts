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
 */
import type { RequestCtx } from "./index.js";

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

  const res = await ctx.env.MIDDLEWARE.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
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
