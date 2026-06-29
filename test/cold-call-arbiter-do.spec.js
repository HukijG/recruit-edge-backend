/**
 * ColdCallArbiter state-machine unit tests.
 *
 * Drives the pure arbiter functions (arbiterMarkCancelled / arbiterMarkTranscript
 * / arbiterAlarm) over a mock storage + mock env so the transcript-always-wins
 * rule is verified across every event ordering — without timers or the DO shell.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  arbiterMarkCancelled,
  arbiterMarkTranscript,
  arbiterAlarm,
} from '../src/cold-call-arbiter-do.js';

function mockStorage() {
  const map = new Map();
  let alarm = null;
  return {
    async get(k) { return map.has(k) ? map.get(k) : undefined; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    async deleteAll() { map.clear(); alarm = null; },
    async setAlarm(t) { alarm = t; },
    async deleteAlarm() { alarm = null; },
    _map: map,
    _alarm: () => alarm,
  };
}

function mockEnv() {
  const fetchMock = vi.fn(async () => new Response('{"ok":true,"recorded":true}', { status: 200 }));
  return { env: { SELF: { fetch: fetchMock }, INTERNAL_SECRET: 'sek' }, fetchMock };
}

const payload = (callId = '99') => ({
  rfCandidateId: 123,
  dialpadUserId: '8000000000000001',
  callId,
  callTimeMs: 1_700_000_000_000,
  contactName: 'Jane Doe',
  finalizeUrl: 'http://internal/internal/coldcall/finalize-cancelled?_otel_trace=abc',
});

describe('ColdCallArbiter', () => {
  it('cancelled-only: alarm finalizes via SELF and marks finalized', async () => {
    const s = mockStorage();
    const { env, fetchMock } = mockEnv();

    const res = await arbiterMarkCancelled(s, payload());
    expect(res.state).toBe('cancelled-pending');
    expect(s._alarm()).toBeTypeOf('number');

    await arbiterAlarm(s, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/internal/coldcall/finalize-cancelled');
    expect(opts.headers['X-Internal-Token']).toBe('sek');
    expect(JSON.parse(opts.body).rfCandidateId).toBe(123);
    expect(await s.get('finalized')).toBe(true);
    expect(await s.get('cancelledPayload')).toBeUndefined();
  });

  it('cancelled then transcript (within grace): transcript supersedes, no finalize', async () => {
    const s = mockStorage();
    const { env, fetchMock } = mockEnv();

    await arbiterMarkCancelled(s, payload());
    const t = await arbiterMarkTranscript(s, '99');
    expect(t.state).toBe('superseded');
    expect(await s.get('cancelledPayload')).toBeUndefined();
    expect(await s.get('finalized')).toBe(true);

    await arbiterAlarm(s, env); // cleanup alarm
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s._map.size).toBe(0);
  });

  it('transcript then cancelled: cancelled suppressed, alarm records nothing', async () => {
    const s = mockStorage();
    const { env, fetchMock } = mockEnv();

    await arbiterMarkTranscript(s, '99');
    const c = await arbiterMarkCancelled(s, payload());
    expect(c.state).toBe('suppressed-transcript');

    await arbiterAlarm(s, env); // lone-transcript grace expiry
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('duplicate hangup deliveries do not double-arm', async () => {
    const s = mockStorage();
    const a = await arbiterMarkCancelled(s, payload());
    const b = await arbiterMarkCancelled(s, payload());
    expect(a.state).toBe('cancelled-pending');
    expect(b.state).toBe('already-pending');
  });

  it('duplicate hangup after finalize is suppressed; cleanup wipes storage', async () => {
    const s = mockStorage();
    const { env, fetchMock } = mockEnv();

    await arbiterMarkCancelled(s, payload());
    await arbiterAlarm(s, env); // finalize
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const dup = await arbiterMarkCancelled(s, payload());
    expect(dup.state).toBe('suppressed-finalized');

    await arbiterAlarm(s, env); // cleanup
    expect(fetchMock).toHaveBeenCalledTimes(1); // not re-finalized
    expect(s._map.size).toBe(0);
  });

  it('non-OK finalize response still marks finalized (no retry storm)', async () => {
    const s = mockStorage();
    const env = { SELF: { fetch: vi.fn(async () => new Response('nope', { status: 500 })) }, INTERNAL_SECRET: 'sek' };

    await arbiterMarkCancelled(s, payload());
    await arbiterAlarm(s, env);
    expect(await s.get('finalized')).toBe(true);
    expect(await s.get('cancelledPayload')).toBeUndefined();
  });
});
