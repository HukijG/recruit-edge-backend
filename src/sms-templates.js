import { trace } from '@opentelemetry/api';

// Server-side ceilings — defense-in-depth; extension also enforces these.
const NAME_MAX = 80;
const BODY_MAX = 2000;
const PER_USER_CAP = 50;

function json(corsHeaders, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// SMS templates are JWT-only — the records are scoped by the OIDC `sub` claim,
// which the legacy `X-Extension-Token` path has no equivalent for. Anything
// reaching authExtensionRequest via the legacy header is bounced here.
function requireJwt(auth, corsHeaders) {
  if (auth.source !== 'jwt') {
    return json(corsHeaders, 401, {
      ok: false,
      error: 'JWT authentication required for this endpoint',
    });
  }
  return null;
}

/**
 * GET /sms-templates → { templates: SmsTemplate[] }
 *
 * Returns every template owned by the authenticated user (scoped by `sub`),
 * ordered by updated_at DESC. Empty array is a valid response — extension
 * treats `templates: []` and a missing field identically.
 */
export async function handleSmsTemplatesList(request, env, corsHeaders, auth) {
  const guard = requireJwt(auth, corsHeaders);
  if (guard) return guard;

  const { results } = await env.USERS_DB.prepare(
    'SELECT id, name, body, created_at, updated_at FROM sms_templates WHERE sub = ? ORDER BY updated_at DESC',
  )
    .bind(auth.sub)
    .all();

  const templates = (results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  trace.getActiveSpan()?.setAttribute('template.count', templates.length);
  return json(corsHeaders, 200, { templates });
}

/**
 * PUT /sms-templates/:id → { ok: true } on success, 4xx on validation failure.
 *
 * Upsert by (sub, id). The extension is the source of truth for createdAt /
 * updatedAt — write whatever it sends rather than stamping server-side.
 * Enforces per-user cap of 50 records, name length, body length, and that
 * `body.id` matches the path segment.
 */
export async function handleSmsTemplateUpsert(request, env, corsHeaders, auth, idFromPath) {
  const guard = requireJwt(auth, corsHeaders);
  if (guard) return guard;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(corsHeaders, 400, { ok: false, error: 'invalid JSON body' });
  }

  const id = typeof payload?.id === 'string' ? payload.id : null;
  if (!id || id !== idFromPath) {
    return json(corsHeaders, 400, {
      ok: false,
      error: 'body.id must equal path id and be a non-empty string',
    });
  }
  const name = typeof payload?.name === 'string' ? payload.name.trim() : null;
  if (!name || name.length === 0 || name.length > NAME_MAX) {
    return json(corsHeaders, 400, {
      ok: false,
      error: `name must be 1..${NAME_MAX} chars after trim`,
    });
  }
  const body = typeof payload?.body === 'string' ? payload.body : null;
  if (body == null || body.length > BODY_MAX) {
    return json(corsHeaders, 400, {
      ok: false,
      error: `body must be a string ≤${BODY_MAX} chars`,
    });
  }
  const createdAt = typeof payload?.createdAt === 'string' ? payload.createdAt : null;
  const updatedAt = typeof payload?.updatedAt === 'string' ? payload.updatedAt : null;
  if (!createdAt || !updatedAt) {
    return json(corsHeaders, 400, {
      ok: false,
      error: 'createdAt and updatedAt must be non-empty ISO-8601 strings',
    });
  }

  const span = trace.getActiveSpan();
  span?.setAttribute('template.id', id);

  // Race window between this SELECT and the INSERT is microseconds for a
  // single-user, low-write-rate workload; if it ever matters we can move
  // the cap check inside a batch() with a triggered abort.
  const existsRow = await env.USERS_DB.prepare(
    'SELECT 1 AS flag FROM sms_templates WHERE sub = ? AND id = ?',
  )
    .bind(auth.sub, id)
    .first();
  const isNew = !existsRow;
  span?.setAttribute('template.create', isNew);
  if (isNew) {
    const countRow = await env.USERS_DB.prepare(
      'SELECT COUNT(*) AS c FROM sms_templates WHERE sub = ?',
    )
      .bind(auth.sub)
      .first();
    if ((countRow?.c ?? 0) >= PER_USER_CAP) {
      span?.setAttribute('template.cap_hit', true);
      return json(corsHeaders, 409, {
        ok: false,
        error: `per-user template cap reached (${PER_USER_CAP})`,
      });
    }
  }

  await env.USERS_DB.prepare(
    `INSERT INTO sms_templates (sub, id, name, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (sub, id) DO UPDATE SET
       name = excluded.name,
       body = excluded.body,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  )
    .bind(auth.sub, id, name, body, createdAt, updatedAt)
    .run();

  return json(corsHeaders, 200, { ok: true });
}

/**
 * DELETE /sms-templates/:id → { ok: true }
 *
 * Idempotent: deleting a missing row is success. The extension already
 * removed the local copy and only fires this as fire-and-forget cleanup.
 */
export async function handleSmsTemplateDelete(request, env, corsHeaders, auth, idFromPath) {
  const guard = requireJwt(auth, corsHeaders);
  if (guard) return guard;

  if (!idFromPath) {
    return json(corsHeaders, 400, { ok: false, error: 'id required in path' });
  }
  trace.getActiveSpan()?.setAttribute('template.id', idFromPath);

  await env.USERS_DB.prepare('DELETE FROM sms_templates WHERE sub = ? AND id = ?')
    .bind(auth.sub, idFromPath)
    .run();

  return json(corsHeaders, 200, { ok: true });
}
