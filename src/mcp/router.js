import { getUserByEmail, getUserByFirstName } from '../users.js';

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

  // No X-MCP-Token check. The only caller is the rf-mcp-remote service binding
  // (within the Cloudflare account boundary). Identity arrives as consultantEmail
  // in the body, derived by the MCP worker from a verified Access JWT.

  let body = {};
  try { body = await request.json(); } catch {}

  let consultant = null;
  if (typeof body.consultantEmail === 'string') {
    consultant = await getUserByEmail(env, body.consultantEmail);
  } else if (typeof body.consultantFirstName === 'string') {
    console.warn(`[mcp] legacy consultantFirstName fallback; tool=${tool}`);
    consultant = await getUserByFirstName(env, body.consultantFirstName);
  }
  if (!consultant) {
    return logged(tool, t0, jsonResponse(403, { ok: false, error: 'Unknown consultant' }));
  }

  const handler = handlers[url.pathname];
  if (!handler) {
    return logged(tool, t0, jsonResponse(404, { ok: false, error: 'not found' }), consultant.firstName);
  }
  const res = await handler({ env, ctx, body, consultant });
  return logged(tool, t0, res, consultant.firstName);
}
