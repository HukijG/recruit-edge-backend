/**
 * Tests for the extension Call/Hangup polling flow (webhook-driven design).
 *
 * The single source of truth for `extcall:callid:{userId}` is the Dialpad
 * webhook handler:
 *   - `calling` events SET the key to the event's call_id (overwrite prior).
 *   - `hangup` events DELETE the key iff their call_id matches what's stored.
 *
 * /dialpad-call doesn't touch KV. /dialpad-hangup reads the call_id from KV
 * to call Dialpad, but doesn't touch KV — the resulting hangup webhook is
 * what clears it. /extension-call-status is a pure KV read.
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

const KV_KEY = 'extcall:callid:8000000000000001';

// ---------------------------------------------------------------------------
// /dialpad-call no longer writes KV (the calling webhook does that)
// ---------------------------------------------------------------------------

describe('/dialpad-call does not write extcall:callid', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await env.SYNC_STATE.delete(KV_KEY);
  });

  it('does not touch KV on Dialpad accept', async () => {
    const alias = await makeAlias('+14155551212');
    mockFetch([
      { match: '/users/8000000000000001/initiate_call', response: { device: { id: 'native-1' } } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/dialpad-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName: 'Joel', phoneNumber: '+447700900123', callerAliasId: alias }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('does not clear a prior call_id (only the hangup webhook can clear)', async () => {
    await env.SYNC_STATE.put(KV_KEY, 'prior-call-id-12345');
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

    // Prior call_id remains until either the new calling webhook overwrites
    // or the matching hangup webhook clears.
    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('prior-call-id-12345');
  });
});

// ---------------------------------------------------------------------------
// /extension-call-status (pure KV read)
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

  it('returns in_progress when KV has a call_id', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'in_progress' });
  });

  it('does not call Dialpad regardless of KV state', async () => {
    const calls = mockFetch([]);

    // empty case
    let ctx = createExecutionContext();
    await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    // populated case
    await env.SYNC_STATE.put(KV_KEY, '99999');
    ctx = createExecutionContext();
    await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(findCalls(calls, 'dialpad.com')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /webhook/dialpad/extension-calls (webhook is the only path that writes KV)
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

  it('calling event sets KV[user] = call_id', async () => {
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('99999');
  });

  it('calling event overwrites a prior call_id', async () => {
    await env.SYNC_STATE.put(KV_KEY, 'prior-12345');
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('99999');
  });

  it('hangup event clears KV when call_id matches', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('hangup event drops when call_id does not match (stale event)', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 88888, target: { id: '8000000000000001' },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('99999');
  });

  it('hangup event drops when KV is empty', async () => {
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('drops inbound events defensively', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'inbound', call_id: 99999, target: { id: '8000000000000001' },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('99999');
  });

  it('drops events for unmonitored target.id', async () => {
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'outbound', call_id: 99999, target: { id: '0000000000000000' },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.SYNC_STATE.get(KV_KEY)).toBeNull();
  });

  it('drops unsupported states (e.g. connected, voicemail)', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    const jwt = await createDialpadJWT({
      state: 'voicemail', direction: 'outbound', call_id: 99999, target: { id: '8000000000000001' },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    // KV unchanged
    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('99999');
  });
});

// ---------------------------------------------------------------------------
// /dialpad-hangup (reads call_id from KV; doesn't clear it)
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

  it('returns 409 when KV has no call_id', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
  });

  it('calls Dialpad hangup with the stored call_id and returns 200', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    const calls = mockFetch([
      { match: '/call/99999/actions/hangup', response: {} },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(findCalls(calls, '/call/99999/actions/hangup')).toHaveLength(1);
  });

  it('does NOT clear KV on success — only the hangup webhook does', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    mockFetch([
      { match: '/call/99999/actions/hangup', response: {} },
    ]);

    const ctx = createExecutionContext();
    await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('99999');
  });

  it('returns 502 when Dialpad rejects, KV unchanged', async () => {
    await env.SYNC_STATE.put(KV_KEY, '99999');
    mockFetch([
      { match: '/call/99999/actions/hangup', status: 404, response: { error: 'Call not found' } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    expect(await env.SYNC_STATE.get(KV_KEY)).toBe('99999');
  });
});
