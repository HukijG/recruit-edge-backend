import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const setAttributeMock = vi.fn();
const activeSpanMock = { setAttribute: setAttributeMock };

vi.mock('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => activeSpanMock },
}));

vi.mock('cloudflare:workers', () => ({
  env: { LOG_NO_BODY: undefined },
}));

let installBodyCapture;
let realFetchOriginal;

describe('body-capture', () => {
  beforeEach(async () => {
    vi.resetModules();
    setAttributeMock.mockClear();
    realFetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      return new Response(JSON.stringify({ ok: true, secret: 'sssh' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    ({ installBodyCapture } = await import('../../src/lib/body-capture.js'));
  });

  afterEach(() => {
    globalThis.fetch = realFetchOriginal;
  });

  it('stamps http.request.body and http.response.body attributes', async () => {
    installBodyCapture();
    await fetch('https://example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Joel', candidate_id: 12345 }),
    });
    const calls = setAttributeMock.mock.calls;
    const reqCall = calls.find(([k]) => k === 'http.request.body');
    const respCall = calls.find(([k]) => k === 'http.response.body');
    expect(reqCall).toBeDefined();
    expect(reqCall[1]).toContain('"name":"Joel"');
    expect(respCall).toBeDefined();
    expect(respCall[1]).toContain('"ok":true');
  });

  it('redacts known sensitive body field names', async () => {
    installBodyCapture();
    await fetch('https://example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Joel', password: 'hunter2', api_key: 'sk_123' }),
    });
    const reqCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.request.body');
    expect(reqCall[1]).toContain('"name":"Joel"');
    expect(reqCall[1]).toContain('"password":"[REDACTED]"');
    expect(reqCall[1]).toContain('"api_key":"[REDACTED]"');
    expect(reqCall[1]).not.toContain('hunter2');
    expect(reqCall[1]).not.toContain('sk_123');
  });

  it('truncates bodies over 32KB with a marker', async () => {
    installBodyCapture();
    const huge = JSON.stringify({ blob: 'x'.repeat(40 * 1024) });
    await fetch('https://example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    const reqCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.request.body');
    expect(reqCall[1].length).toBeLessThanOrEqual(32 * 1024 + 60);
    expect(reqCall[1]).toMatch(/…\[truncated, original \d+ bytes\]$/);
  });

  it('skips non-text content types', async () => {
    installBodyCapture();
    await fetch('https://example.com/image.png', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: 'binary-blob',
    });
    const reqCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.request.body');
    expect(reqCall).toBeUndefined();
  });

  it('redacts secret-shaped URL query params', async () => {
    installBodyCapture();
    await fetch('https://example.com/api?apikey=abc&user=joel&token=xyz');
    const urlCall = setAttributeMock.mock.calls.find(([k]) => k === 'url.full.redacted');
    expect(urlCall).toBeDefined();
    expect(urlCall[1]).toContain('apikey=%5BREDACTED%5D');
    expect(urlCall[1]).toContain('user=joel');
    expect(urlCall[1]).toContain('token=%5BREDACTED%5D');
  });

  it('is idempotent', async () => {
    installBodyCapture();
    const after = globalThis.fetch;
    installBodyCapture();
    expect(globalThis.fetch).toBe(after);
  });

  it('LOG_NO_BODY=1 disables body capture', async () => {
    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: { LOG_NO_BODY: '1' } }));
    setAttributeMock.mockClear();
    const mod = await import('../../src/lib/body-capture.js');
    mod.installBodyCapture();
    await fetch('https://example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Joel' }),
    });
    expect(setAttributeMock).not.toHaveBeenCalledWith('http.request.body', expect.any(String));
  });
});
