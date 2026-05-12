import { describe, it, expect } from 'vitest';
import { resolveOtelConfig } from '../../src/lib/otel-config.js';

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

  it('configures sampling with full-rate head sampler that accepts remote', () => {
    const config = resolveOtelConfig({ LD_SDK_KEY: 'sdk-key-abc' });
    expect(config.sampling.headSampler.ratio).toBe(1);
    expect(config.sampling.headSampler.acceptRemote).toBe(true);
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
