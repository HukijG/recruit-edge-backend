/**
 * Tests for the SMS templates cloud-backup routes:
 *   GET    /sms-templates              → list templates for the authenticated user
 *   PUT    /sms-templates/:id          → upsert one template by id
 *   DELETE /sms-templates/:id          → delete one template by id (idempotent)
 *
 * All routes are JWT-authed (App 2 SaaS-OIDC); records are scoped by the `sub`
 * claim. Legacy X-Extension-Token is rejected — there's no sub for it to
 * scope by.
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { ensureAccessJwksFixture, mintAccessJwt } from './helpers/access-jwt-mint.js';
import { _resetCacheForTests } from '../src/users.js';
import worker from '../src';

beforeAll(async () => {
  await ensureAccessJwksFixture();
});

beforeEach(async () => {
  await applyUsersMigration(env);
  _resetCacheForTests();
});

const SUB_A = 'oidc-sub-a';
const SUB_B = 'oidc-sub-b';

async function bearerHeaders(opts = {}) {
  const jwt = await mintAccessJwt(env, {
    email: opts.email ?? 'joel@test.local',
    sub: opts.sub ?? SUB_A,
  });
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
  };
}

function templateBody(overrides = {}) {
  return {
    id: '9d4f0000-0000-4000-8000-000000000001',
    name: 'Cold open',
    body: 'Hey {{firstName}}, …',
    createdAt: '2026-05-13T09:15:00.000Z',
    updatedAt: '2026-05-13T11:42:00.000Z',
    ...overrides,
  };
}

async function putTemplate(headers, record) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://example.com/sms-templates/${encodeURIComponent(record.id)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(record),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function listTemplates(headers) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request('http://example.com/sms-templates', { method: 'GET', headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function deleteTemplate(headers, id) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://example.com/sms-templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('GET /sms-templates', () => {
  it('401 with no auth headers', async () => {
    const res = await listTemplates({});
    expect(res.status).toBe(401);
  });

  it('401 with legacy X-Extension-Token (JWT-only endpoint)', async () => {
    const res = await listTemplates({
      'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/JWT/i);
  });

  it('returns { templates: [] } for a user with no records', async () => {
    const headers = await bearerHeaders();
    const res = await listTemplates(headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ templates: [] });
  });

  it('returns the authenticated user’s templates ordered by updated_at DESC', async () => {
    const headers = await bearerHeaders();
    await putTemplate(
      headers,
      templateBody({
        id: 'a',
        name: 'first',
        updatedAt: '2026-05-13T01:00:00.000Z',
      }),
    );
    await putTemplate(
      headers,
      templateBody({
        id: 'b',
        name: 'second',
        updatedAt: '2026-05-13T03:00:00.000Z',
      }),
    );
    await putTemplate(
      headers,
      templateBody({
        id: 'c',
        name: 'third',
        updatedAt: '2026-05-13T02:00:00.000Z',
      }),
    );

    const res = await listTemplates(headers);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.templates.map((t) => t.name)).toEqual(['second', 'third', 'first']);
  });

  it('isolates templates by sub (user A cannot see user B’s records)', async () => {
    const headersA = await bearerHeaders({ sub: SUB_A });
    const headersB = await bearerHeaders({ sub: SUB_B });
    await putTemplate(headersA, templateBody({ id: 'a-1', name: 'A only' }));
    await putTemplate(headersB, templateBody({ id: 'b-1', name: 'B only' }));

    const resA = await listTemplates(headersA);
    const resB = await listTemplates(headersB);
    expect((await resA.json()).templates.map((t) => t.name)).toEqual(['A only']);
    expect((await resB.json()).templates.map((t) => t.name)).toEqual(['B only']);
  });
});

describe('PUT /sms-templates/:id', () => {
  it('400 when body.id is missing', async () => {
    const headers = await bearerHeaders();
    const res = await putTemplate(headers, templateBody({ id: undefined }));
    expect(res.status).toBe(400);
  });

  it('400 when body.id does not match path id', async () => {
    const headers = await bearerHeaders();
    const ctx = createExecutionContext();
    const record = templateBody({ id: 'in-body' });
    const res = await worker.fetch(
      new Request('http://example.com/sms-templates/in-path', {
        method: 'PUT',
        headers,
        body: JSON.stringify(record),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when name > 80 chars after trim', async () => {
    const headers = await bearerHeaders();
    const res = await putTemplate(headers, templateBody({ name: 'x'.repeat(81) }));
    expect(res.status).toBe(400);
  });

  it('400 when body > 2000 chars', async () => {
    const headers = await bearerHeaders();
    const res = await putTemplate(headers, templateBody({ body: 'x'.repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it('400 when createdAt or updatedAt is missing', async () => {
    const headers = await bearerHeaders();
    const r1 = await putTemplate(headers, templateBody({ createdAt: undefined }));
    const r2 = await putTemplate(headers, templateBody({ updatedAt: undefined }));
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });

  it('200 inserts a new row visible in subsequent GET', async () => {
    const headers = await bearerHeaders();
    const insertRes = await putTemplate(headers, templateBody({ id: 't1', name: 'Hello' }));
    expect(insertRes.status).toBe(200);
    expect(await insertRes.json()).toEqual({ ok: true });

    const listRes = await listTemplates(headers);
    const json = await listRes.json();
    expect(json.templates).toHaveLength(1);
    expect(json.templates[0]).toMatchObject({ id: 't1', name: 'Hello' });
  });

  it('200 updates an existing row in place (overwrites name, body, updatedAt)', async () => {
    const headers = await bearerHeaders();
    await putTemplate(
      headers,
      templateBody({ id: 't1', name: 'Old', body: 'Old body', updatedAt: '2026-05-13T01:00:00.000Z' }),
    );
    const updateRes = await putTemplate(
      headers,
      templateBody({ id: 't1', name: 'New', body: 'New body', updatedAt: '2026-05-13T02:00:00.000Z' }),
    );
    expect(updateRes.status).toBe(200);

    const listRes = await listTemplates(headers);
    const json = await listRes.json();
    expect(json.templates).toHaveLength(1);
    expect(json.templates[0]).toMatchObject({
      id: 't1',
      name: 'New',
      body: 'New body',
      updatedAt: '2026-05-13T02:00:00.000Z',
    });
  });

  it('trims the name before applying length check and storing', async () => {
    const headers = await bearerHeaders();
    const res = await putTemplate(headers, templateBody({ id: 't-trim', name: '  trimmed  ' }));
    expect(res.status).toBe(200);
    const json = await (await listTemplates(headers)).json();
    expect(json.templates[0].name).toBe('trimmed');
  });

  it('409 once per-user cap of 50 new templates is reached', async () => {
    const headers = await bearerHeaders();
    // Insert 50 records.
    for (let i = 0; i < 50; i++) {
      const r = await putTemplate(headers, templateBody({ id: `t-${i}`, name: `t${i}` }));
      expect(r.status).toBe(200);
    }
    // 51st new id → 409.
    const overflow = await putTemplate(headers, templateBody({ id: 't-overflow', name: 'too many' }));
    expect(overflow.status).toBe(409);
  });

  it('cap does not block updating an existing template even when at the cap', async () => {
    const headers = await bearerHeaders();
    for (let i = 0; i < 50; i++) {
      await putTemplate(headers, templateBody({ id: `t-${i}`, name: `t${i}` }));
    }
    // Re-PUT id t-0 (already exists) — should pass even though count is at cap.
    const update = await putTemplate(
      headers,
      templateBody({ id: 't-0', name: 'updated at-cap' }),
    );
    expect(update.status).toBe(200);
  });

  it('401 with legacy X-Extension-Token', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('http://example.com/sms-templates/t1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
        body: JSON.stringify(templateBody({ id: 't1' })),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /sms-templates/:id', () => {
  it('200 removes an existing row', async () => {
    const headers = await bearerHeaders();
    await putTemplate(headers, templateBody({ id: 'doomed' }));
    const delRes = await deleteTemplate(headers, 'doomed');
    expect(delRes.status).toBe(200);
    const listRes = await listTemplates(headers);
    expect((await listRes.json()).templates).toEqual([]);
  });

  it('200 (idempotent) when the id does not exist', async () => {
    const headers = await bearerHeaders();
    const res = await deleteTemplate(headers, 'never-existed');
    expect(res.status).toBe(200);
  });

  it('does not delete another user’s template with the same id', async () => {
    const headersA = await bearerHeaders({ sub: SUB_A });
    const headersB = await bearerHeaders({ sub: SUB_B });
    await putTemplate(headersA, templateBody({ id: 'shared-id', name: 'A version' }));
    await putTemplate(headersB, templateBody({ id: 'shared-id', name: 'B version' }));

    const delRes = await deleteTemplate(headersA, 'shared-id');
    expect(delRes.status).toBe(200);

    const listB = await listTemplates(headersB);
    expect((await listB.json()).templates.map((t) => t.name)).toEqual(['B version']);
  });

  it('401 with legacy X-Extension-Token', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('http://example.com/sms-templates/t1', {
        method: 'DELETE',
        headers: { 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
