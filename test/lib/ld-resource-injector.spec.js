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

describe('makeLdResourceInjector — url attribute redaction', () => {
  it('redacts secret-shaped query params in span.attributes["url.full"]', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'fetch',
      resource: baseResource,
      attributes: {
        'http.method': 'GET',
        'url.full': 'https://api.example.com/foo?apikey=SECRET&user=joel&token=xyz',
      },
    };
    const [out] = injector([span]);
    expect(out.attributes['url.full']).toContain('apikey=%5BREDACTED%5D');
    expect(out.attributes['url.full']).toContain('token=%5BREDACTED%5D');
    expect(out.attributes['url.full']).toContain('user=joel');
    expect(out.attributes['url.full']).not.toContain('SECRET');
    expect(out.attributes['url.full']).not.toContain('xyz');
  });

  it('redacts secret-shaped query params in span.attributes["url.query"]', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'fetch',
      resource: baseResource,
      attributes: {
        'url.query': 'apikey=SECRET&user=joel',
      },
    };
    const [out] = injector([span]);
    expect(out.attributes['url.query']).toContain('apikey=%5BREDACTED%5D');
    expect(out.attributes['url.query']).toContain('user=joel');
    expect(out.attributes['url.query']).not.toContain('SECRET');
  });

  it('leaves attributes unchanged when no url-like keys are present', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const original = { 'db.statement': 'SELECT * FROM users WHERE token=keep_me' };
    const span = { name: 's', resource: baseResource, attributes: original };
    const [out] = injector([span]);
    // db.statement contains "token=keep_me" but it's not a URL — don't touch it.
    expect(out.attributes['db.statement']).toBe('SELECT * FROM users WHERE token=keep_me');
  });

  it('leaves a URL without secret-shaped params untouched', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'fetch',
      resource: baseResource,
      attributes: { 'url.full': 'https://api.example.com/foo?user=joel&candidate_id=12345' },
    };
    const [out] = injector([span]);
    expect(out.attributes['url.full']).toBe('https://api.example.com/foo?user=joel&candidate_id=12345');
  });

  it('handles a span with no attributes object', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = { name: 's', resource: baseResource };
    const [out] = injector([span]);
    // Should not throw; resource enrichment still works
    expect(out.resource.attributes['launchdarkly.project_id']).toBe('key');
  });

  it('handles a frozen span via wrapper-object path (preserves URL redaction)', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const frozenSpan = Object.freeze({
      name: 's',
      resource: baseResource,
      attributes: { 'url.full': 'https://api.example.com/foo?token=SECRET' },
    });
    const [out] = injector([frozenSpan]);
    expect(out.resource.attributes['launchdarkly.project_id']).toBe('key');
    expect(out.attributes['url.full']).toContain('token=%5BREDACTED%5D');
    expect(out.attributes['url.full']).not.toContain('SECRET');
  });
});
