import { describe, it, expect } from 'vitest';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { resolveOtelConfig } from '../../src/lib/otel-config.js';

// This protects the 5-line vendor patch at vendor/otel-cf-workers/src/spanprocessor.ts:84
// from silent revert by:
//   1. asking resolveOtelConfig for the wired postProcessor,
//   2. invoking it with a hand-rolled ReadableSpan-shaped stub,
//   3. asserting the returned span carries launchdarkly.project_id on its resource attributes.
//
// If a future @microlabs/otel-cf-workers vendor merge drops the postProcessor invocation
// in BatchTraceSpanProcessor.exportSpans, production LD ingestion silently breaks
// because the launchdarkly.project_id resource attribute would never be injected.
// The test does NOT exercise the vendor path directly — see otel-postprocessor.spec.js
// for the rationale and the alternative integration-style harness that was considered
// (instantiating BatchTraceSpanProcessor with a mock exporter, driving onStart/onEnd to
// hit exportSpans). The unit-level invocation is enough because the postProcessor IS the
// patch's payload — if the vendor calls it, the LD attribute appears; if the vendor
// skips it, this test still passes BUT production ingestion stops working. We rely on
// the vendor patch's docstring comment + a separate manual smoke (curl + LD UI) to catch
// the latter regression class. A direct vendor-level integration test would need a
// significant harness (real Span construction, context setConfig, mock exporter) and is
// not justified for a 5-line patch on pinned vendor code.

describe('otel-config postProcessor wiring (vendor patch guard)', () => {
  it('postProcessor injects launchdarkly.project_id on each span resource', () => {
    const env = { LD_SDK_KEY: 'sdk-key-vendor-test' };
    const config = resolveOtelConfig(env);
    expect(typeof config.postProcessor).toBe('function');

    // Hand-rolled minimal ReadableSpan: name + resource (the only fields the injector
    // touches). Mirrors the shape vendor passes to config.postProcessor(spans).
    const baseResource = resourceFromAttributes({ 'service.name': 'rf-dialpad-sync-dev' });
    const stubSpan = {
      name: 'test-span',
      kind: 1,
      status: { code: 0 },
      resource: baseResource,
      attributes: {},
    };

    const [out] = config.postProcessor([stubSpan]);

    // The launchdarkly.project_id resource attribute MUST be present — this is what LD
    // uses to route spans to the correct project. Without it, LD silently drops the span.
    expect(out.resource.attributes['launchdarkly.project_id']).toBe('sdk-key-vendor-test');
    // Original service.name must still be present (the injector merges, doesn't replace).
    expect(out.resource.attributes['service.name']).toBe('rf-dialpad-sync-dev');
  });

  it('postProcessor preserves non-resource span fields (passes through name/kind/status)', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'k' });
    const baseResource = resourceFromAttributes({ 'service.name': 'rf-dialpad-sync-dev' });
    const stubSpan = {
      name: 'fetch /candidates',
      kind: 3,
      status: { code: 0, message: 'OK' },
      resource: baseResource,
      attributes: { 'http.method': 'GET' },
    };
    const [out] = config.postProcessor([stubSpan]);
    expect(out.name).toBe('fetch /candidates');
    expect(out.kind).toBe(3);
    expect(out.status).toEqual({ code: 0, message: 'OK' });
    expect(out.attributes['http.method']).toBe('GET');
  });

  it('postProcessor handles empty spans array without throwing', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'k' });
    expect(() => config.postProcessor([])).not.toThrow();
    expect(config.postProcessor([])).toEqual([]);
  });
});
