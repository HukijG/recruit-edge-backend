/**
 * Tests for the extension Call/Hangup polling flow.
 *
 * Covers:
 *   - /dialpad-call's KV side-effect (writing the extcall:state JSON record)
 *   - /extension-call-status (KV-first read, discovery branch)
 *   - /webhook/dialpad/extension-calls (hangup webhook, match-or-ignore)
 *   - /dialpad-hangup (new JSON shape, already-ended fast path)
 *   - findCallForBind (pure helper)
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import worker from '../src';

const originalFetch = globalThis.fetch;

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, opts });
    for (const route of routes) {
      if (urlStr.includes(route.match)) {
        if (typeof route.response === 'function') return route.response(urlStr, opts);
        return new Response(JSON.stringify(route.response), {
          status: route.status || 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'unmocked' }), { status: 500 });
  };
  return calls;
}

function findCalls(calls, pattern) {
  return calls.filter(c => c.url.includes(pattern));
}

async function makeAlias(number) {
  const { signCallerIdAlias } = await import('../src/dialpad-aliases.js');
  return signCallerIdAlias(number, env);
}

async function createDialpadJWT(payload) {
  const secret = new TextEncoder().encode(env.DIALPAD_WEBHOOK_SECRET);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret);
}

const KV_KEY = 'extcall:state:8000000000000001';

// ---------------------------------------------------------------------------
// /dialpad-call → KV write side-effect
// ---------------------------------------------------------------------------

describe('/dialpad-call writes extcall:state KV record', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await env.SYNC_STATE.delete(KV_KEY);
  });

  it('writes {phoneNumber, initiatedAt, state:in_progress} after Dialpad accepts', async () => {
    const alias = await makeAlias('+14155551212');
    mockFetch([
      { match: '/users/8000000000000001/initiate_call', response: { device: { id: 'native-1' } } },
    ]);

    const before = Date.now();
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/dialpad-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName: 'Joel', phoneNumber: '+447700900123', callerAliasId: alias }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const record = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(record.phoneNumber).toBe('+447700900123');
    expect(record.state).toBe('in_progress');
    expect(record.callId).toBeUndefined();
    expect(typeof record.initiatedAt).toBe('number');
    expect(record.initiatedAt).toBeGreaterThanOrEqual(before);
    expect(record.initiatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('overwrites a prior call record (clears stale state)', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155559999',
      initiatedAt: Date.now() - 60_000,
      callId: 'stale-call-id',
      state: 'in_progress',
    }));
    const alias = await makeAlias('+14155551212');
    mockFetch([
      { match: '/users/8000000000000001/initiate_call', response: { device: { id: 'native-1' } } },
    ]);

    const ctx = createExecutionContext();
    await worker.fetch(new Request('http://example.com/dialpad-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName: 'Joel', phoneNumber: '+447700900123', callerAliasId: alias }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);

    const record = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(record.phoneNumber).toBe('+447700900123');
    expect(record.callId).toBeUndefined();
  });

  it('does not write extcall:state when Dialpad rejects', async () => {
    const alias = await makeAlias('+14155551212');
    mockFetch([
      { match: '/users/8000000000000001/initiate_call', status: 400, response: { error: 'No autocallable device' } },
    ]);

    const ctx = createExecutionContext();
    await worker.fetch(new Request('http://example.com/dialpad-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName: 'Joel', phoneNumber: '+447700900123', callerAliasId: alias }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /extension-call-status
// ---------------------------------------------------------------------------

describe('/extension-call-status', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await env.SYNC_STATE.delete(KV_KEY);
  });

  function statusReq(consultantFirstName = 'Joel') {
    return new Request('http://example.com/extension-call-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName }),
    });
  }

  it('returns 401 without X-Extension-Token', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/extension-call-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('returns 400 when consultantFirstName missing', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/extension-call-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({}),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });

  it('returns 403 when consultant not in registry', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq('Nobody'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
  });

  it('returns ended when KV is empty', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'ended' });
  });

  it('returns in_progress without touching Dialpad when callId is bound', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, callId: '12345', state: 'in_progress',
    }));
    const calls = mockFetch([]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'in_progress' });
    expect(findCalls(calls, '/api/v2/calls')).toHaveLength(0);
  });

  it('returns ended when state is already ended', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, callId: '12345', state: 'ended',
    }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.json()).toEqual({ state: 'ended' });
  });

  it('discovery: writes callId and returns in_progress when list-calls finds a match', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 500, state: 'in_progress',
    }));
    mockFetch([
      {
        match: '/api/v2/calls',
        response: {
          items: [{ call_id: 99999, state: 'calling', direction: 'outbound', external_number: '+14155551212' }],
        },
      },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'in_progress' });

    const stored = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(stored.callId).toBe('99999');
    expect(stored.state).toBe('in_progress');
  });

  it('discovery: returns in_progress without writing callId when list-calls has no match', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 500, state: 'in_progress',
    }));
    mockFetch([
      { match: '/api/v2/calls', response: { items: [] } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'in_progress' });

    const stored = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(stored.callId).toBeUndefined();
  });

  it('discovery: returns 502 when Dialpad list-calls fails', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 500, state: 'in_progress',
    }));
    mockFetch([
      { match: '/api/v2/calls', status: 429, response: { error: 'rate limited' } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// /webhook/dialpad/extension-calls
// ---------------------------------------------------------------------------

describe('/webhook/dialpad/extension-calls', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await env.SYNC_STATE.delete(KV_KEY);
  });

  function webhookReq(jwt) {
    return new Request('http://example.com/webhook/dialpad/extension-calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: '',
    });
  }

  it('returns 401 without a JWT', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/webhook/dialpad/extension-calls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '',
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('flips state to ended when callId matches', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, callId: '99999', state: 'in_progress',
    }));
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const stored = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(stored.state).toBe('ended');
    expect(stored.callId).toBe('99999');
  });

  it('drops events when call_id does not match', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, callId: '99999', state: 'in_progress',
    }));
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 88888, target: { id: '8000000000000001' },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const stored = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(stored.state).toBe('in_progress');
  });

  it('drops events when no record exists', async () => {
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('drops events when callId is not yet bound', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, state: 'in_progress',
    }));
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const stored = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(stored.state).toBe('in_progress');
    expect(stored.callId).toBeUndefined();
  });

  it('drops inbound events defensively', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, callId: '99999', state: 'in_progress',
    }));
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'inbound', call_id: 99999, target: { id: '8000000000000001' },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const stored = JSON.parse(await env.SYNC_STATE.get(KV_KEY));
    expect(stored.state).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// /dialpad-hangup with the new extcall:state JSON shape
// ---------------------------------------------------------------------------

describe('/dialpad-hangup', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await env.SYNC_STATE.delete(KV_KEY);
  });

  function hangupReq(consultantFirstName = 'Joel') {
    return new Request('http://example.com/dialpad-hangup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName }),
    });
  }

  it('returns 409 when KV has no record', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
  });

  it('returns 409 when KV record has no callId yet', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 500, state: 'in_progress',
    }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
  });

  it('calls Dialpad hangup, clears KV, returns 200 on the normal path', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, callId: '99999', state: 'in_progress',
    }));
    const calls = mockFetch([
      { match: '/call/99999/actions/hangup', response: {} },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(findCalls(calls, '/call/99999/actions/hangup')).toHaveLength(1);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('skips Dialpad and returns 200 on the already-ended fast path', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 60_000, callId: '99999', state: 'ended',
    }));
    const calls = mockFetch([]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(findCalls(calls, '/actions/hangup')).toHaveLength(0);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('clears KV even when Dialpad rejects (returns 502)', async () => {
    await env.SYNC_STATE.put(KV_KEY, JSON.stringify({
      phoneNumber: '+14155551212', initiatedAt: Date.now() - 1000, callId: '99999', state: 'in_progress',
    }));
    mockFetch([
      { match: '/call/99999/actions/hangup', status: 404, response: { error: 'Call not found' } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('returns 409 on malformed KV value', async () => {
    await env.SYNC_STATE.put(KV_KEY, 'not-json{{{');
    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// findCallForBind (pure helper)
// ---------------------------------------------------------------------------

describe('findCallForBind (discovery filter)', () => {
  const phoneNumber = '+14155551212';

  it('returns null on empty / null / undefined input', async () => {
    const { findCallForBind } = await import('../src/extension-calls.js');
    expect(findCallForBind([], { phoneNumber })).toBeNull();
    expect(findCallForBind(null, { phoneNumber })).toBeNull();
    expect(findCallForBind(undefined, { phoneNumber })).toBeNull();
  });

  it('matches an outbound calling-state call with matching external_number', async () => {
    const { findCallForBind } = await import('../src/extension-calls.js');
    const items = [
      { call_id: 999, state: 'calling', direction: 'outbound', external_number: '+14155551212' },
    ];
    expect(findCallForBind(items, { phoneNumber })?.call_id).toBe(999);
  });

  it('matches connected state too', async () => {
    const { findCallForBind } = await import('../src/extension-calls.js');
    const items = [
      { call_id: 1000, state: 'connected', direction: 'outbound', external_number: '+14155551212' },
    ];
    expect(findCallForBind(items, { phoneNumber })?.call_id).toBe(1000);
  });

  it('rejects terminated calls (state=hangup)', async () => {
    const { findCallForBind } = await import('../src/extension-calls.js');
    const items = [
      { call_id: 999, state: 'hangup', direction: 'outbound', external_number: '+14155551212' },
    ];
    expect(findCallForBind(items, { phoneNumber })).toBeNull();
  });

  it('rejects inbound calls', async () => {
    const { findCallForBind } = await import('../src/extension-calls.js');
    const items = [
      { call_id: 999, state: 'connected', direction: 'inbound', external_number: '+14155551212' },
    ];
    expect(findCallForBind(items, { phoneNumber })).toBeNull();
  });

  it('rejects mismatched external_number', async () => {
    const { findCallForBind } = await import('../src/extension-calls.js');
    const items = [
      { call_id: 999, state: 'calling', direction: 'outbound', external_number: '+14155559999' },
    ];
    expect(findCallForBind(items, { phoneNumber })).toBeNull();
  });

  it('returns the first match (most-recent ordering)', async () => {
    const { findCallForBind } = await import('../src/extension-calls.js');
    const items = [
      { call_id: 1001, state: 'calling', direction: 'outbound', external_number: '+14155551212' },
      { call_id: 999, state: 'connected', direction: 'outbound', external_number: '+14155551212' },
    ];
    expect(findCallForBind(items, { phoneNumber })?.call_id).toBe(1001);
  });
});
