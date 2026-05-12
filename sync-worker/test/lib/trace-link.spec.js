import { describe, it, expect, vi } from 'vitest';

const traceId32 = 'a'.repeat(32);
const spanCtx = { traceId: traceId32 };
const activeSpanMock = { spanContext: () => spanCtx };

vi.mock('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => activeSpanMock },
}));

import { makeAsyncCallbackUrl, readInboundTraceLink } from '../../src/lib/trace-link.js';

describe('makeAsyncCallbackUrl', () => {
  it('appends _otel_trace with current trace ID', () => {
    const url = makeAsyncCallbackUrl('https://example.com/webhook?token=abc', { rfId: 12345 });
    expect(url).toContain('_otel_trace=' + traceId32);
    expect(url).toContain('rfId=12345');
    expect(url).toContain('token=abc');
  });

  it('returns base URL unchanged if no active span', async () => {
    vi.resetModules();
    vi.doMock('@opentelemetry/api', () => ({ trace: { getActiveSpan: () => null } }));
    const mod = await import('../../src/lib/trace-link.js');
    const url = mod.makeAsyncCallbackUrl('https://example.com/webhook', { rfId: 12345 });
    expect(url).not.toContain('_otel_trace');
    expect(url).toContain('rfId=12345');
  });
});

describe('readInboundTraceLink', () => {
  it('returns linkCtx for a valid 32-hex trace ID', () => {
    const req = new Request('https://example.com/webhook?_otel_trace=' + traceId32);
    const link = readInboundTraceLink(req);
    expect(link).toEqual({ traceId: traceId32, spanId: '0'.repeat(16), traceFlags: 1 });
  });

  it('returns null when _otel_trace param is missing', () => {
    const req = new Request('https://example.com/webhook');
    expect(readInboundTraceLink(req)).toBeNull();
  });

  it('returns null for malformed trace ID', () => {
    const req = new Request('https://example.com/webhook?_otel_trace=not-hex');
    expect(readInboundTraceLink(req)).toBeNull();
  });
});
