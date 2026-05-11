import { describe, it, expect } from 'vitest';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { makeLdResourceInjector } from '../../src/lib/ld-resource-injector.js';

describe('makeLdResourceInjector', () => {
  it('throws if sdkKey is missing', () => {
    expect(() => makeLdResourceInjector(undefined)).toThrow(/LD_SDK_KEY/);
    expect(() => makeLdResourceInjector('')).toThrow(/LD_SDK_KEY/);
  });

  it('injects launchdarkly.project_id on each span resource', () => {
    const injector = makeLdResourceInjector('test-sdk-key-abc-123');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = { name: 's1', resource: baseResource };
    const result = injector([span]);
    expect(result).toHaveLength(1);
    expect(result[0].resource.attributes['launchdarkly.project_id']).toBe('test-sdk-key-abc-123');
    expect(result[0].resource.attributes['service.name']).toBe('test');
  });

  it('handles empty spans array', () => {
    const injector = makeLdResourceInjector('key');
    expect(injector([])).toEqual([]);
  });

  it('preserves non-resource properties on each span', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = { name: 's1', kind: 1, status: { code: 0 }, resource: baseResource };
    const result = injector([span]);
    expect(result[0].name).toBe('s1');
    expect(result[0].kind).toBe(1);
    expect(result[0].status).toEqual({ code: 0 });
  });

  it('falls back to Proxy wrapping if defineProperty throws on a frozen span', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const frozenSpan = Object.freeze({ name: 's1', resource: baseResource });
    const result = injector([frozenSpan]);
    expect(result[0].resource.attributes['launchdarkly.project_id']).toBe('key');
    expect(result[0].name).toBe('s1');
  });
});
