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

  it('captures outbound request body when called as fetch(Request, undefined)', async () => {
    installBodyCapture();
    const req = new Request('https://example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Joel', candidate_id: 9876 }),
    });
    await fetch(req);
    const reqCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.request.body');
    expect(reqCall, 'request body must be captured from the Request object when init is undefined').toBeDefined();
    expect(reqCall[1]).toContain('"name":"Joel"');
    expect(reqCall[1]).toContain('"candidate_id":9876');
  });

  it('streams oversized responses without materialising the full body', async () => {
    // Build a streaming Response that emits 80KB in 8KB chunks BEFORE installing
    // the wrap, so realFetch captures this stream-producing fetch. The reader.cancel()
    // path inside body-capture must short-circuit before pulling every chunk.
    const CHUNK_BYTES = 8 * 1024;
    const TOTAL_BYTES = 80 * 1024;
    let chunksProduced = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunksProduced * CHUNK_BYTES >= TOTAL_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode('a'.repeat(CHUNK_BYTES)));
        chunksProduced++;
      },
    });
    const streamingResponse = new Response(stream, {
      headers: { 'content-type': 'text/plain' },
    });
    globalThis.fetch = vi.fn(async () => streamingResponse);
    installBodyCapture();

    await fetch('https://example.com/big');

    const respCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.response.body');
    expect(respCall).toBeDefined();
    expect(respCall[1]).toMatch(/…\[truncated, original >\d+ bytes\]$/);
    // The captured body must not contain the full 80KB — strictly bounded by the truncation budget.
    expect(respCall[1].length).toBeLessThan(TOTAL_BYTES);
    // And we cancelled the reader early, so we shouldn't have pulled every chunk.
    expect(chunksProduced).toBeLessThan(TOTAL_BYTES / CHUNK_BYTES);
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

  it('redacts PII-shaped URL query params (email, phone, linkedin, attendee_email, attendee_phone)', async () => {
    installBodyCapture();
    await fetch('https://example.com/api?email=joel%40example.com&phone=%2B15551234567&linkedin=https%3A%2F%2Flinkedin.com%2Fin%2Fjoel&attendee_email=guest%40example.com&attendee_phone=%2B15559999999&user=joel');
    const urlCall = setAttributeMock.mock.calls.find(([k]) => k === 'url.full.redacted');
    expect(urlCall).toBeDefined();
    expect(urlCall[1]).toContain('email=%5BREDACTED%5D');
    expect(urlCall[1]).toContain('phone=%5BREDACTED%5D');
    expect(urlCall[1]).toContain('linkedin=%5BREDACTED%5D');
    expect(urlCall[1]).toContain('attendee_email=%5BREDACTED%5D');
    expect(urlCall[1]).toContain('attendee_phone=%5BREDACTED%5D');
    expect(urlCall[1]).toContain('user=joel');
    expect(urlCall[1]).not.toContain('joel%40example.com');
    expect(urlCall[1]).not.toContain('15551234567');
    expect(urlCall[1]).not.toContain('linkedin.com%2Fin%2Fjoel');
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

  it('OTEL_DISABLED=1 skips the fetch wrapper entirely', async () => {
    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: { OTEL_DISABLED: '1' } }));
    setAttributeMock.mockClear();
    const beforeFetch = globalThis.fetch;
    const mod = await import('../../src/lib/body-capture.js');
    mod.installBodyCapture();
    // The wrap must not have been installed — globalThis.fetch is unchanged.
    expect(globalThis.fetch).toBe(beforeFetch);
    await fetch('https://example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Joel' }),
    });
    expect(setAttributeMock).not.toHaveBeenCalled();
  });
});

describe('captureInboundBody / captureResponseBody', () => {
  beforeEach(() => {
    vi.resetModules();
    // Earlier tests in this file call `vi.doMock('cloudflare:workers', ...)`
    // with kill-switch flags set; without resetting here the leaked mock
    // would suppress body capture in every test below. Reapply the default
    // (no flags set) explicitly.
    vi.doMock('cloudflare:workers', () => ({ env: { LOG_NO_BODY: undefined } }));
    setAttributeMock.mockClear();
  });

  it('stamps http.request.body on the active span from an inbound JSON Request', async () => {
    const { captureInboundBody } = await import('../../src/lib/body-capture.js');
    const req = new Request('https://internal/mcp/candidate-get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 49243, fields: ['phone'] }),
    });
    const result = await captureInboundBody(req);
    expect(result).toContain('"id":49243');
    const reqCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.request.body');
    expect(reqCall).toBeDefined();
    expect(reqCall[1]).toContain('"fields":["phone"]');
  });

  it('redacts password / token fields in the inbound body', async () => {
    const { captureInboundBody } = await import('../../src/lib/body-capture.js');
    const req = new Request('https://internal/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Joel', api_key: 'sk_secret' }),
    });
    const result = await captureInboundBody(req);
    expect(result).toContain('"api_key":"[REDACTED]"');
    expect(result).toContain('"name":"Joel"');
  });

  it('returns null for non-JSON/text content types (skips binary)', async () => {
    const { captureInboundBody } = await import('../../src/lib/body-capture.js');
    const req = new Request('https://internal/x', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'binary-body',
    });
    const result = await captureInboundBody(req);
    expect(result).toBeNull();
    const reqCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.request.body');
    expect(reqCall).toBeUndefined();
  });

  it('stamps http.response.body on the active span from a Response', async () => {
    const { captureResponseBody } = await import('../../src/lib/body-capture.js');
    const res = new Response(JSON.stringify({ ok: true, count: 3 }), {
      headers: { 'content-type': 'application/json' },
    });
    const returned = await captureResponseBody(res);
    expect(returned).toBe(res);
    const respCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.response.body');
    expect(respCall).toBeDefined();
    expect(respCall[1]).toContain('"ok":true');
  });

  it('captureResponseBody returns the response unchanged on failure paths', async () => {
    const { captureResponseBody } = await import('../../src/lib/body-capture.js');
    const res = new Response('not-json', { headers: { 'content-type': 'text/plain' } });
    const returned = await captureResponseBody(res);
    // Even on text/plain (still in the allowlist), the response object is the same instance.
    expect(returned).toBe(res);
  });

  it('captureInboundBody honours LOG_NO_BODY=1', async () => {
    vi.doMock('cloudflare:workers', () => ({ env: { LOG_NO_BODY: '1' } }));
    const { captureInboundBody } = await import('../../src/lib/body-capture.js');
    const req = new Request('https://internal/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Joel' }),
    });
    const result = await captureInboundBody(req);
    expect(result).toBeNull();
    const reqCall = setAttributeMock.mock.calls.find(([k]) => k === 'http.request.body');
    expect(reqCall).toBeUndefined();
  });
});
