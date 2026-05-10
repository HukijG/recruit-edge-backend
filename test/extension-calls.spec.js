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
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
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

beforeEach(async () => {
  await applyUsersMigration(env);
  _resetCacheForTests();
});

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
// Daily call-counter behaviour driven by hangup webhooks
// ---------------------------------------------------------------------------

describe('hangup webhook → daily call counter', () => {
  const JOEL_RF_USER_ID = 900001;

  function todayKey() {
    const today = new Date().toISOString().slice(0, 10);
    return `callstats:daily:${JOEL_RF_USER_ID}:${today}`;
  }

  beforeEach(async () => {
    await clearDO();
    await env.SYNC_STATE.delete(todayKey());
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await clearDO();
    await env.SYNC_STATE.delete(todayKey());
  });

  function webhookReq(jwt) {
    return new Request('http://example.com/webhook/dialpad/extension-calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: '',
    });
  }

  it('increments the counter on every outbound hangup, regardless of DO match', async () => {
    // First call: matches the DO state
    await seedDO('111');
    const jwt1 = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 111, target: { id: JOEL_DIALPAD_ID },
    });
    let ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt1), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.SYNC_STATE.get(todayKey())).toBe('1');

    // Second call: hangup for a callId not in the DO (e.g., placed via Dialpad app)
    const jwt2 = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 222, target: { id: JOEL_DIALPAD_ID },
    });
    ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt2), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.SYNC_STATE.get(todayKey())).toBe('2');
  });

  it('does NOT increment for inbound hangups', async () => {
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'inbound', call_id: 333, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.SYNC_STATE.get(todayKey())).toBeNull();
  });

  it('does NOT increment for unmonitored target.id', async () => {
    const jwt = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 444, target: { id: '0000000000000000' },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.SYNC_STATE.get(todayKey())).toBeNull();
  });

  it('does NOT increment for non-hangup states (calling, voicemail, etc.)', async () => {
    const jwt = await createDialpadJWT({
      state: 'calling', direction: 'outbound', call_id: 555, target: { id: JOEL_DIALPAD_ID },
    });
    const ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwt), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.SYNC_STATE.get(todayKey())).toBeNull();
  });

  it('counts each consultant separately', async () => {
    const ALICE_DIALPAD_ID = '8000000000000002';
    const ALICE_RF_USER_ID = 900002;
    const today = new Date().toISOString().slice(0, 10);

    // Joel makes one call
    await env.SYNC_STATE.delete(`callstats:daily:${JOEL_RF_USER_ID}:${today}`);
    await env.SYNC_STATE.delete(`callstats:daily:${ALICE_RF_USER_ID}:${today}`);

    const jwtJoel = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 666, target: { id: JOEL_DIALPAD_ID },
    });
    let ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwtJoel), env, ctx);
    await waitOnExecutionContext(ctx);

    // Alice makes two calls
    const jwtAlice1 = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 777, target: { id: ALICE_DIALPAD_ID },
    });
    ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwtAlice1), env, ctx);
    await waitOnExecutionContext(ctx);

    const jwtAlice2 = await createDialpadJWT({
      state: 'hangup', direction: 'outbound', call_id: 888, target: { id: ALICE_DIALPAD_ID },
    });
    ctx = createExecutionContext();
    await worker.fetch(webhookReq(jwtAlice2), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.SYNC_STATE.get(`callstats:daily:${JOEL_RF_USER_ID}:${today}`)).toBe('1');
    expect(await env.SYNC_STATE.get(`callstats:daily:${ALICE_RF_USER_ID}:${today}`)).toBe('2');

    // Cleanup
    await env.SYNC_STATE.delete(`callstats:daily:${ALICE_RF_USER_ID}:${today}`);
  });
});

// ---------------------------------------------------------------------------
// /call-stats endpoint
// ---------------------------------------------------------------------------

describe('/call-stats', () => {
  const JOEL_RF_USER_ID = 900001;

  function todayKey() {
    const today = new Date().toISOString().slice(0, 10);
    return `callstats:daily:${JOEL_RF_USER_ID}:${today}`;
  }

  beforeEach(async () => {
    await env.SYNC_STATE.delete(todayKey());
  });
  afterEach(async () => {
    await env.SYNC_STATE.delete(todayKey());
  });

  function statsReq(consultantFirstName = 'Joel') {
    return new Request('http://example.com/call-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({ consultantFirstName }),
    });
  }

  it('returns 401 without X-Extension-Token', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/call-stats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consultantFirstName: 'Joel' }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('returns 400 when consultantFirstName missing', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://example.com/call-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET },
      body: JSON.stringify({}),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });

  it('returns 403 when consultant not in registry', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(statsReq('Nobody'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
  });

  it('returns daily=0 when no calls yet today', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(statsReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ daily: 0 });
  });

  it('returns the current daily count', async () => {
    await env.SYNC_STATE.put(todayKey(), '7');
    const ctx = createExecutionContext();
    const response = await worker.fetch(statsReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.json()).toEqual({ daily: 7 });
  });

  it('handles malformed counter values defensively (returns 0)', async () => {
    await env.SYNC_STATE.put(todayKey(), 'not-a-number');
    const ctx = createExecutionContext();
    const response = await worker.fetch(statsReq(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.json()).toEqual({ daily: 0 });
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
