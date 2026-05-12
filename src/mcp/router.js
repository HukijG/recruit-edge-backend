import { trace } from '@opentelemetry/api';
import { getUserByEmail, getUserByFirstName } from '../users.js';
import { captureInboundBody, captureResponseBody } from '../lib/body-capture.js';

export function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Emit a structured log line for every /mcp/* response. CF Logs picks the
 * object form up as queryable JSON; the `message` string is the human-
 * readable line used by `wrangler tail`. Consultant first-name is included
 * when known (early auth/parse failures don't have it).
 */
function logged(tool, t0, response, consultantFirstName) {
  const took_ms = Date.now() - t0;
  const entry = { tool, status: response.status, took_ms };
  if (consultantFirstName) entry.consultant = consultantFirstName;
  entry.message = `[mcp] ${tool} status=${response.status} took_ms=${took_ms}`
    + (consultantFirstName ? ` consultant=${consultantFirstName}` : '');
  console.log(entry);
  return response;
}

export async function routeMcp(request, env, ctx, handlers) {
  const t0 = Date.now();
  const url = new URL(request.url);
  const tool = url.pathname;

  // Inbound body capture on the active root span. Lets the trace UI show
  // "Claude asked for: candidate-get id=49243 fields=['phone']" without
  // having to drill into the service-binding client span on the upstream
  // worker. Pair with `captureResponseBody` below for full request/response
  // symmetry on the entry handler. Honours LOG_NO_BODY / OTEL_DISABLED.
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('mcp.tool', tool);
    try { await captureInboundBody(request, span); } catch { /* never block on telemetry */ }
  }

  // No X-MCP-Token check. The only caller is the rf-mcp-remote service binding
  // (within the Cloudflare account boundary). Identity arrives as consultantEmail
  // in the body, derived by the MCP worker from a verified Access JWT.

  let body = {};
  try { body = await request.json(); } catch {}

  let consultant = null;
  if (typeof body.consultantEmail === 'string') {
    consultant = await getUserByEmail(env, body.consultantEmail);
  } else if (typeof body.consultantFirstName === 'string') {
    console.warn({ source: 'mcp-router', message: '[mcp] legacy consultantFirstName fallback', tool });
    consultant = await getUserByFirstName(env, body.consultantFirstName);
  }
  if (!consultant) {
    const res = jsonResponse(403, { ok: false, error: 'Unknown consultant' });
    await captureResponseBody(res, span);
    return logged(tool, t0, res);
  }
  if (span) span.setAttribute('mcp.consultant.email', consultant.email ?? '');

  const handler = handlers[url.pathname];
  if (!handler) {
    const res = jsonResponse(404, { ok: false, error: 'not found' });
    await captureResponseBody(res, span);
    return logged(tool, t0, res, consultant.firstName);
  }
  const res = await handler({ env, ctx, body, consultant });
  // Stamp outcome attributes derived from the response body — quick to
  // query without parsing the captured body string each time. Best-effort:
  // only peeks at the cloned response.
  if (span) {
    try {
      const peek = await res.clone().json();
      if (peek && typeof peek === 'object') {
        if (peek.ok === false && typeof peek.kind === 'string') {
          span.setAttribute('mcp.outcome.kind', peek.kind);
        } else if (peek.needs_disambiguation === true) {
          span.setAttribute('mcp.outcome.kind', 'needs_disambiguation');
        } else if (peek.ok === true) {
          span.setAttribute('mcp.outcome.kind', 'ok');
        }
      }
    } catch { /* response isn't JSON — skip */ }
  }
  await captureResponseBody(res, span);
  return logged(tool, t0, res, consultant.firstName);
}
