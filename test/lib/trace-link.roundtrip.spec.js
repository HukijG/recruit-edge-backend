import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { makeAsyncCallbackUrl, readInboundTraceLink } from '../../src/lib/trace-link.js';

// This file deliberately does NOT mock @opentelemetry/api — it exercises the helpers
// against the real OTel context/span APIs to prove the round-trip contract: an async
// kickoff serialises the active span's traceId into the URL, and the inbound side
// reads a matching trace context back out.
//
// @opentelemetry/api has a no-op ContextManager by default, so context.with() does
// nothing useful unless a manager is registered. Tests need a sync one to make
// trace.setSpanContext + context.with + trace.getActiveSpan actually compose.

const syncContextManager = (() => {
  let active = ROOT_CONTEXT;
  return {
    active() { return active; },
    with(ctx, fn, thisArg, ...args) {
      const prev = active;
      active = ctx;
      try { return fn.call(thisArg, ...args); } finally { active = prev; }
    },
    bind(_ctx, target) { return target; },
    enable() { return this; },
    disable() { return this; },
  };
})();

describe('trace-link round trip with real @opentelemetry/api', () => {
  beforeAll(() => { context.setGlobalContextManager(syncContextManager); });
  afterAll(() => { context.disable(); });

  it('round-trips trace context across async kickoff', () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    const spanId = '0123456789abcdef';
    const spanContext = { traceId, spanId, traceFlags: 1, isRemote: false };

    // 1+2. Build an active span context with traceId/spanId, call makeAsyncCallbackUrl under it.
    const callbackUrl = context.with(
      trace.setSpanContext(context.active(), spanContext),
      () => makeAsyncCallbackUrl('https://callback.example/path'),
    );
    expect(callbackUrl).toContain('_otel_trace=' + traceId);

    // 3. Construct a new Request from the resulting URL.
    const inboundRequest = new Request(callbackUrl);

    // 4. Call readInboundTraceLink(request).
    const link = readInboundTraceLink(inboundRequest);

    // 5. Assert returned link's traceId matches.
    expect(link).not.toBeNull();
    expect(link.traceId).toBe(traceId);
  });
});
