import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listDialpadCalls, listDialpadCallsPage } from '../src/dialpad-list-client.js';

const env = {
  DIALPAD_API_KEY: 'test-key',
  DIALPAD_API_BASE_URL: 'https://dialpad.com/api/v2',
};

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn();
});

function mockPages(pages /* Array<{items, cursor}> */) {
  let i = 0;
  globalThis.fetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => pages[i++] ?? { items: [], cursor: null },
    text: async () => '',
    headers: new Map([['content-type', 'application/json']]),
  }));
}

describe('listDialpadCalls', () => {
  it('paginates until cursor is null', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPages([
      { items: [{ call_id: 'a' }, { call_id: 'b' }], cursor: 't1' },
      { items: [{ call_id: 'c' }], cursor: null },
    ]);
    const out = await listDialpadCalls({}, env);
    expect(out.map(c => c.call_id)).toEqual(['a', 'b', 'c']);
  });

  it('omits every filter URL param when opts is empty (org-wide seed listing)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPages([{ items: [], cursor: null }]);
    await listDialpadCalls({}, env);
    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.searchParams.has('target_id')).toBe(false);
    expect(url.searchParams.has('target_type')).toBe(false);
    expect(url.searchParams.has('started_after')).toBe(false);
    expect(url.searchParams.has('started_before')).toBe(false);
    expect(url.searchParams.has('include_anonymized')).toBe(false);
    expect(url.pathname).toBe('/api/v2/call');
  });

  it('passes targetId/targetType/started_after/started_before when provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPages([{ items: [], cursor: null }]);
    await listDialpadCalls({
      targetId: '8000000000000001',
      targetType: 'user',
      startedAfterMs: 1717248000000,
      startedBeforeMs: 1719840000000,
    }, env);
    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('target_id')).toBe('8000000000000001');
    expect(url.searchParams.get('target_type')).toBe('user');
    expect(url.searchParams.get('started_after')).toBe('1717248000000');
    expect(url.searchParams.get('started_before')).toBe('1719840000000');
  });

  it('passes include_anonymized=true only when explicitly set', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPages([{ items: [], cursor: null }]);
    await listDialpadCalls({ includeAnonymized: true }, env);
    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('include_anonymized')).toBe('true');
  });

  it('caps at the default 25 pages and emits a structured warn log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pages = Array.from({ length: 30 }, (_, i) => ({
      items: [{ call_id: `c${i}` }],
      cursor: i < 29 ? `t${i}` : null,
    }));
    mockPages(pages);
    const out = await listDialpadCalls({}, env);
    expect(out.length).toBe(25);
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
      source: 'dialpad-list-client',
      pages: 25,
      message: expect.stringContaining('maxPages=25'),
    }));
  });

  it('honors opts.maxPages override (seed backfill)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pages = Array.from({ length: 30 }, (_, i) => ({
      items: [{ call_id: `c${i}` }],
      cursor: i < 29 ? `t${i}` : null,
    }));
    mockPages(pages);
    const out = await listDialpadCalls({ maxPages: 30 }, env);
    expect(out.length).toBe(30);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits a structured per-page log with url, status, item_count, has_cursor', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPages([
      { items: [{ call_id: 'a' }, { call_id: 'b' }], cursor: 't1' },
      { items: [{ call_id: 'c' }], cursor: null },
    ]);
    await listDialpadCalls({ startedAfterMs: 1717248000000 }, env);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: 'dialpad-list-client',
      status: 200,
      item_count: 2,
      has_cursor: true,
    }));
    expect(logSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      item_count: 1,
      has_cursor: false,
    }));
    expect(logSpy.mock.calls[0][0].url).toMatch(/started_after=1717248000000/);
  });

  it('forwards cursor on subsequent pages (no cursor on first request)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPages([
      { items: [{ call_id: 'a' }], cursor: 't1' },
      { items: [{ call_id: 'b' }], cursor: null },
    ]);
    await listDialpadCalls({}, env);
    expect(globalThis.fetch.mock.calls[0][0]).not.toContain('cursor=');
    expect(new URL(globalThis.fetch.mock.calls[1][0]).searchParams.get('cursor')).toBe('t1');
  });

  it('throws with HTTP status in message on non-2xx and emits an error log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch.mockImplementation(async () => ({
      ok: false, status: 401,
      text: async () => 'unauthorized',
      json: async () => ({}),
      headers: new Map(),
    }));
    await expect(listDialpadCalls({}, env)).rejects.toThrow(/HTTP 401/);
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({
      source: 'dialpad-list-client',
      status: 401,
    }));
  });
});

describe('listDialpadCallsPage', () => {
  it('returns { items, cursor } for a single page (no internal loop)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [{ call_id: 'a' }, { call_id: 'b' }], cursor: 'next-tok' }),
      text: async () => '',
      headers: new Map([['content-type', 'application/json']]),
    }));
    const r = await listDialpadCallsPage({}, env);
    expect(r).toEqual({ items: [{ call_id: 'a' }, { call_id: 'b' }], cursor: 'next-tok' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('passes opts.cursor through to the URL', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [], cursor: null }),
      text: async () => '',
      headers: new Map([['content-type', 'application/json']]),
    }));
    await listDialpadCallsPage({ cursor: 'tok-42' }, env);
    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('cursor')).toBe('tok-42');
  });

  it('omits all filter params when opts is empty', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [], cursor: null }),
      text: async () => '',
      headers: new Map([['content-type', 'application/json']]),
    }));
    await listDialpadCallsPage({}, env);
    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.searchParams.has('target_id')).toBe(false);
    expect(url.searchParams.has('target_type')).toBe(false);
    expect(url.searchParams.has('started_after')).toBe(false);
    expect(url.searchParams.has('started_before')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('returns cursor: null when Dialpad does not send one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [{ call_id: 'a' }] }),
      text: async () => '',
      headers: new Map([['content-type', 'application/json']]),
    }));
    const r = await listDialpadCallsPage({}, env);
    expect(r.cursor).toBeNull();
  });

  it('throws on non-2xx (caller responsible for retry)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch.mockImplementation(async () => ({
      ok: false, status: 500, text: async () => 'oops', json: async () => ({}), headers: new Map(),
    }));
    await expect(listDialpadCallsPage({}, env)).rejects.toThrow(/HTTP 500/);
  });
});
