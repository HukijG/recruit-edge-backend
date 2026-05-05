/**
 * Tests for the extension Call/Hangup polling flow.
 *
 * Storage moved from KV to a per-user Durable Object (ExtCallState) for
 * strong consistency. Same external behaviour:
 *   - `calling` webhook → DO.setCallId (overwrite-on-write)
 *   - `hangup` webhook with matching call_id → DO.clearCallIdIfMatch
 *   - /extension-call-status reads DO, returns in_progress / ended
 *   - /dialpad-hangup reads DO, calls Dialpad, doesn't clear (webhook does)
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import worker from '../src';

const originalFetch = globalThis.fetch;
const JOEL_DIALPAD_ID = '8000000000000001';

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

// Test helpers — talk directly to the DO so tests can seed/clear state.
function getDOStub() {
  return env.EXT_CALL_STATE.get(env.EXT_CALL_STATE.idFromName(JOEL_DIALPAD_ID));
}

async function clearDO() {
  const stub = getDOStub();
  const stored = await stub.getCallId();
  if (stored) await stub.clearCallIdIfMatch(stored);
}

async function seedDO(callId) {
  await getDOStub().setCallId(callId);
}

async function readDO() {
  return await getDOStub().getCallId();
}

// ---------------------------------------------------------------------------
// /dialpad-call no longer writes call-state (the calling webhook does)
// ---------------------------------------------------------------------------

describe('/dialpad-call does not write call-state directly', () => {
  beforeEach(async () => { await clearDO(); });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await clearDO();
  });

  it('does not touch the DO on Dialpad accept', async () => {
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
    expect(await readDO()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /extension-call-status (pure DO read, strongly consistent)
// ---------------------------------------------------------------------------

describe('/extension-call-status', () => {
  beforeEach(async () => { await clearDO(); });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await clearDO();
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

  it('returns ended when DO has no call_id', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'ended' });
  });

  it('returns in_progress when DO has a call_id', async () => {
    await seedDO('99999');
    const ctx = createExecutionContext();
    const response = await worker.fetch(statusReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'in_progress' });
  });

  it('does not call Dialpad regardless of DO state', async () => {
    const calls = mockFetch([]);
    const ctx1 = createExecutionContext();
    await worker.fetch(statusReq(), env, ctx1);
    await waitOnExecutionContext(ctx1);

    await seedDO('99999');
    const ctx2 = createExecutionContext();
    await worker.fetch(statusReq(), env, ctx2);
    await waitOnExecutionContext(ctx2);

    expect(findCalls(calls, 'dialpad.com')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /webhook/dialpad/extension-calls (the only writer)
// ---------------------------------------------------------------------------

describe('/webhook/dialpad/extension-calls', () => {
  beforeEach(async () => { await clearDO(); });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await clearDO();
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

  it('calling event sets DO call_id', async () => {
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'outbound', call_id: 99999, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await readDO()).toBe('99999');
  });

  it('calling event overwrites a prior call_id', async () => {
    await seedDO('prior-12345');
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'outbound', call_id: 99999, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await readDO()).toBe('99999');
  });

  it('hangup event clears DO when call_id matches', async () => {
    await seedDO('99999');
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 99999, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await readDO()).toBeNull();
  });

  it('hangup event drops when call_id does not match (stale event)', async () => {
    await seedDO('99999');
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 88888, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await readDO()).toBe('99999');
  });

  it('hangup event drops when DO is empty', async () => {
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 99999, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await readDO()).toBeNull();
  });

  it('drops inbound events defensively', async () => {
    await seedDO('99999');
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'inbound', call_id: 99999, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await readDO()).toBe('99999');
  });

  it('drops events for unmonitored target.id', async () => {
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'outbound', call_id: 99999, target: { id: '0000000000000000' },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await readDO()).toBeNull();
  });

  it('drops unsupported states (e.g. voicemail)', async () => {
    await seedDO('99999');
    const jwt = await createDialpadJWT({
      state: 'voicemail', direction: 'outbound', call_id: 99999, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await readDO()).toBe('99999');
  });
});

// ---------------------------------------------------------------------------
// /dialpad-hangup (reads call_id from DO; doesn't clear it)
// ---------------------------------------------------------------------------

describe('/dialpad-hangup', () => {
  beforeEach(async () => { await clearDO(); });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await clearDO();
  });

  function hangupReq(consultantFirstName = 'Joel') {
    return new Request('http://example.com/dialpad-hangup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName }),
    });
  }

  it('returns 409 when DO has no call_id', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
  });

  it('calls Dialpad hangup with the stored call_id and returns 200', async () => {
    await seedDO('99999');
    const calls = mockFetch([
      { match: '/call/99999/actions/hangup', response: {} },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(findCalls(calls, '/call/99999/actions/hangup')).toHaveLength(1);
  });

  it('does NOT clear the DO on success — only the hangup webhook does', async () => {
    await seedDO('99999');
    mockFetch([
      { match: '/call/99999/actions/hangup', response: {} },
    ]);

    const ctx = createExecutionContext();
    await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await readDO()).toBe('99999');
  });

  it('returns 502 when Dialpad rejects, DO unchanged', async () => {
    await seedDO('99999');
    mockFetch([
      { match: '/call/99999/actions/hangup', status: 404, response: { error: 'Call not found' } },
    ]);

    const ctx = createExecutionContext();
    const response = await worker.fetch(hangupReq(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    expect(await readDO()).toBe('99999');
  });
});
