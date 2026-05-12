import { describe, it, expect } from 'vitest';
import { ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { resolveOtelConfig, PathRatioSampler, SamplingDecision } from '../../src/lib/otel-config.js';

describe('resolveOtelConfig', () => {
  it('throws if env.LD_SDK_KEY is missing', () => {
    expect(() => resolveOtelConfig({})).toThrow(/LD_SDK_KEY/);
  });

  it('returns the default LD traces exporter URL when LD_OTLP_TRACES_URL is unset', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc' });
    expect(config.exporter.url).toBe('https://otel.observability.app.launchdarkly.com/v1/traces');
  });

  it('honours LD_OTLP_TRACES_URL override', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc', LD_OTLP_TRACES_URL: 'https://custom.example/traces' });
    expect(config.exporter.url).toBe('https://custom.example/traces');
  });

  it('wires a postProcessor function (LD resource injector)', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc' });
    expect(typeof config.postProcessor).toBe('function');
  });

  it('configures a Sampler-object head sampler (path-ratio, parent-based)', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc' });
    // @microlabs's config check uses .shouldSample as the discriminator
    // between {ratio, acceptRemote} configs and full Sampler objects.
    expect(typeof config.sampling.headSampler.shouldSample).toBe('function');
  });

  it('enables global fetch and cache instrumentation', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc' });
    expect(config.instrumentation.instrumentGlobalFetch).toBe(true);
    expect(config.instrumentation.instrumentGlobalCache).toBe(true);
  });

  it('resolves service.name to the main worker service identifier', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc' });
    expect(config.service.name).toBe('rf-dialpad-sync-dev');
  });
});

describe('PathRatioSampler', () => {
  function decide(sampler, path) {
    // Use a fixed trace id so the per-test result is deterministic and
    // doesn't fluctuate with random IDs.
    const traceId = '00000000000000000000000000000001';
    return sampler.shouldSample(
      ROOT_CONTEXT, traceId, 'spanName', SpanKind.SERVER,
      { 'url.path': path },
      [],
    );
  }

  it('requires rules.default', () => {
    expect(() => new PathRatioSampler({})).toThrow(/default/);
    expect(() => new PathRatioSampler({ '/x': 0.5 })).toThrow(/default/);
  });

  it('returns RECORD_AND_SAMPLED for unmatched paths when default=1', () => {
    const sampler = new PathRatioSampler({ default: 1.0 });
    expect(decide(sampler, '/anything').decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('returns NOT_RECORD when default=0', () => {
    const sampler = new PathRatioSampler({ default: 0 });
    expect(decide(sampler, '/anything').decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it('uses the per-path ratio when the URL matches exactly', () => {
    // ratio=0 ensures the matched path is always dropped, demonstrating
    // routing without needing a probabilistic assertion.
    const sampler = new PathRatioSampler({ '/extension-call-status': 0, default: 1.0 });
    expect(decide(sampler, '/extension-call-status').decision).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(sampler, '/other-route').decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('falls back to http.target when url.path is absent', () => {
    const sampler = new PathRatioSampler({ '/poll': 0, default: 1.0 });
    const traceId = '00000000000000000000000000000001';
    const r = sampler.shouldSample(
      ROOT_CONTEXT, traceId, 'spanName', SpanKind.SERVER,
      { 'http.target': '/poll' },
      [],
    );
    expect(r.decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it('toString includes the configured rules (for SDK debug logging)', () => {
    const sampler = new PathRatioSampler({ '/extension-call-status': 0.1, default: 1.0 });
    expect(sampler.toString()).toMatch(/extension-call-status.*0\.1/);
  });
});

describe('resolveOtelConfig polling sample-rate', () => {
  // The exact ratio math is OTel's TraceIdRatioBasedSampler concern; here we
  // verify only that resolveOtelConfig's headSampler routes by path to a
  // sub-sampler that uses the configured ratio. The deterministic ratio=0
  // route below proves dispatch + child-sampler selection without depending
  // on the internal XOR-accumulate threshold math.
  it('routes /extension-call-status to the lower-ratio sub-sampler', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc' });
    // Pick a non-trivial trace ID so we don't accidentally fall under any
    // small upper bound (small-magnitude IDs XOR to small values).
    const traceId = 'deadbeefcafebabe0123456789abcdef';
    const defaultDecision = config.sampling.headSampler.shouldSample(
      ROOT_CONTEXT, traceId, 'root', SpanKind.SERVER,
      { 'url.path': '/health' }, [],
    );
    // default ratio = 1.0 → every valid trace ID is RECORD_AND_SAMPLED.
    expect(defaultDecision.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    // The polling decision is non-deterministic in the test scope but the
    // *sampler* it routes to is constructed with ratio 0.1, which we can
    // assert structurally.
    const polling = config.sampling.headSampler._root?.samplers?.get('/extension-call-status');
    // Internal field access here is intentional — the test is asserting
    // structural composition, not just behavior; if the implementation moves
    // off TraceIdRatioBasedSampler this test deliberately breaks.
    expect(polling).toBeDefined();
    expect(polling._ratio).toBe(0.1);
  });
});
