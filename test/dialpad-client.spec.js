import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DialpadHttpError,
  listDialpadCalls,
  getDialpadCall,
} from '../src/dialpad-client.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('DialpadHttpError', () => {
  it('carries status, body, message', () => {
    const err = new DialpadHttpError(429, { code: 'rate' }, 'rate-limited');
    expect(err.status).toBe(429);
    expect(err.body).toEqual({ code: 'rate' });
    expect(err.message).toBe('rate-limited');
    expect(err.name).toBe('DialpadHttpError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('listDialpadCalls', () => {
  it('builds the correct URL and returns { items, cursor }', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ call_id: '1' }], cursor: 'abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const out = await listDialpadCalls({
      targetId: '8000000000000001',
      targetType: 'user',
      startedAfterMs: 1700000000000,
      startedBeforeMs: 1700864000000,
      cursor: null,
    }, { DIALPAD_API_KEY: 'k', DIALPAD_API_BASE_URL: 'https://dialpad.com/api/v2' });

    expect(out).toEqual({ items: [{ call_id: '1' }], cursor: 'abc' });
    const [calledUrl, opts] = globalThis.fetch.mock.calls[0];
    const u = new URL(String(calledUrl));
    expect(u.pathname).toBe('/api/v2/call');
    expect(u.searchParams.get('target_id')).toBe('8000000000000001');
    expect(u.searchParams.get('target_type')).toBe('user');
    expect(u.searchParams.get('started_after')).toBe('1700000000000');
    expect(u.searchParams.get('started_before')).toBe('1700864000000');
    expect(u.searchParams.has('cursor')).toBe(false);
    expect(opts.headers.Authorization).toBe('Bearer k');
  });

  it('passes cursor when set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    await listDialpadCalls({
      targetId: '8000000000000001', targetType: 'user', startedAfterMs: 1, startedBeforeMs: 2, cursor: 'CURSOR',
    }, { DIALPAD_API_KEY: 'k' });
    const u = new URL(String(globalThis.fetch.mock.calls[0][0]));
    expect(u.searchParams.get('cursor')).toBe('CURSOR');
  });

  it('throws DialpadHttpError with parsed JSON body on non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad' }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(listDialpadCalls({
      targetId: '1', targetType: 'user', startedAfterMs: 1, startedBeforeMs: 2,
    }, { DIALPAD_API_KEY: 'k' })).rejects.toMatchObject({
      name: 'DialpadHttpError',
      status: 500,
      body: { error: 'bad' },
    });
  });

  it('throws DialpadHttpError with raw text body when non-JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('plain html oopsies', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(listDialpadCalls({
      targetId: '1', targetType: 'user', startedAfterMs: 1, startedBeforeMs: 2,
    }, { DIALPAD_API_KEY: 'k' })).rejects.toMatchObject({
      name: 'DialpadHttpError',
      status: 502,
      body: 'plain html oopsies',
    });
  });

  it('errors when DIALPAD_API_KEY is missing', async () => {
    await expect(listDialpadCalls({
      targetId: '1', targetType: 'user', startedAfterMs: 1, startedBeforeMs: 2,
    }, {})).rejects.toThrow(/DIALPAD_API_KEY/);
  });

  it('returns empty items[] when Dialpad omits the items field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cursor: 'x' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await listDialpadCalls({
      targetId: '1', targetType: 'user', startedAfterMs: 1, startedBeforeMs: 2,
    }, { DIALPAD_API_KEY: 'k' });
    expect(out).toEqual({ items: [], cursor: 'x' });
  });

  it('omits the cursor query param when cursor is empty string', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], cursor: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    await listDialpadCalls({
      targetId: '1', targetType: 'user', startedAfterMs: 1, startedBeforeMs: 2, cursor: '',
    }, { DIALPAD_API_KEY: 'k' });
    const u = new URL(String(globalThis.fetch.mock.calls[0][0]));
    expect(u.searchParams.has('cursor')).toBe(false);
  });

  it('propagates transport errors as-is (not wrapped in DialpadHttpError)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(listDialpadCalls({
      targetId: '1', targetType: 'user', startedAfterMs: 1, startedBeforeMs: 2,
    }, { DIALPAD_API_KEY: 'k' })).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Failed to fetch',
    });
  });
});

describe('getDialpadCall', () => {
  it('GETs /api/v2/call/{id} and returns the body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ call_id: '555', target: { id: '999', type: 'user' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await getDialpadCall('555', { DIALPAD_API_KEY: 'k' });
    expect(out.call_id).toBe('555');
    const u = new URL(String(globalThis.fetch.mock.calls[0][0]));
    expect(u.pathname).toBe('/api/v2/call/555');
  });

  it('throws DialpadHttpError on 429', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    await expect(getDialpadCall('1', { DIALPAD_API_KEY: 'k' })).rejects.toMatchObject({
      status: 429,
      name: 'DialpadHttpError',
    });
  });
});
