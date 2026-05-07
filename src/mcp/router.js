import { getUserByFirstName } from '../users.js';

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function routeMcp(request, env, ctx, handlers) {
  const token = request.headers.get('X-MCP-Token') ?? '';
  if (!env.MCP_EXTENSION_SECRET || !timingSafeEqual(token, env.MCP_EXTENSION_SECRET)) {
    return jsonResponse(401, { ok: false, error: 'auth' });
  }
  const url = new URL(request.url);
  let body = {};
  try { body = await request.json(); } catch {}
  const consultant = getUserByFirstName(body.consultantFirstName);
  if (!consultant) return jsonResponse(403, { ok: false, error: 'Unknown consultant' });
  const handler = handlers[url.pathname];
  if (!handler) return jsonResponse(404, { ok: false, error: 'not found' });
  return handler({ env, ctx, body, consultant });
}
