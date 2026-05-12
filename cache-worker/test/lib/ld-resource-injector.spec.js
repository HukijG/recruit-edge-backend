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

describe('makeLdResourceInjector — noise attribute pruning', () => {
  it('drops NOISE_KEYS from span.attributes', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'fetch',
      resource: baseResource,
      attributes: {
        'cloud.platform': 'cloudflare.workers',
        'cloud.provider': 'cloudflare',
        'cloud.region': 'earth',
        'faas.invocation_id': 'abc',
        'faas.trigger': 'http',
        'faas.max_memory': 134217728,
        'net.asn': 396982,
        'net.colo': 'IAD',
        'net.country': 'US',
        'net.tcp_rtt': 9,
        'net.tls_cipher': 'AEAD-AES256-GCM-SHA384',
        'net.tls_version': 'TLSv1.3',
        'network.protocol.name': 'http',
        'network.protocol.version': 'HTTP/1.1',
        'http.accept_encoding': 'gzip',
        'http.accepts': 'application/json',
        'telemetry.sdk.language': 'js',
        'telemetry.sdk.name': '@microlabs/otel-cf-workers',
        'telemetry.sdk.version': '1.0.0-rc.52',
        'telemetry.sdk.build.node_version': 'v22.x.x',
        'url.domain': 'example.com',
        'url.scheme': 'https:',
        'feature_flag.set.id': 'xyz',
        'flow.name': 'Health',
        'http.url.full': 'https://example.com',
        'http.url.path': '/path',
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'faas.coldstart': false,
        'server.address': 'api.example.com',
        'user_agent.original': 'curl/7.0',
        'dialpad.event_type': 'hangup',
        'consultant.email': 'joel@example.com',
      },
    };
    const [out] = injector([span]);
    for (const dropped of [
      'cloud.platform', 'cloud.provider', 'cloud.region',
      'faas.invocation_id', 'faas.trigger', 'faas.max_memory',
      'net.asn', 'net.colo', 'net.country', 'net.tcp_rtt', 'net.tls_cipher', 'net.tls_version',
      'network.protocol.name', 'network.protocol.version',
      'http.accept_encoding', 'http.accepts',
      'telemetry.sdk.language', 'telemetry.sdk.name', 'telemetry.sdk.version', 'telemetry.sdk.build.node_version',
      'url.domain', 'url.scheme',
      'feature_flag.set.id',
    ]) {
      expect(out.attributes[dropped]).toBeUndefined();
    }
    expect(out.attributes['flow.name']).toBe('Health');
    expect(out.attributes['http.url.full']).toBe('https://example.com');
    expect(out.attributes['http.url.path']).toBe('/path');
    expect(out.attributes['http.request.method']).toBe('GET');
    expect(out.attributes['http.response.status_code']).toBe(200);
    expect(out.attributes['faas.coldstart']).toBe(false);
    expect(out.attributes['server.address']).toBe('api.example.com');
    expect(out.attributes['user_agent.original']).toBe('curl/7.0');
    expect(out.attributes['dialpad.event_type']).toBe('hangup');
    expect(out.attributes['consultant.email']).toBe('joel@example.com');
  });

  it('drops NOISE_KEYS from resource.attributes (and keeps service.name + adds launchdarkly.project_id)', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({
      'service.name': 'rf-mcp-cache-sync',
      'cloud.platform': 'cloudflare.workers',
      'cloud.provider': 'cloudflare',
      'cloud.region': 'earth',
      'faas.max_memory': 134217728,
      'telemetry.sdk.name': '@microlabs/otel-cf-workers',
      'telemetry.sdk.version': '1.0.0-rc.52',
      'telemetry.sdk.language': 'js',
      'telemetry.sdk.build.node_version': 'v22.x.x',
    });
    const span = { name: 's', resource: baseResource, attributes: {} };
    const [out] = injector([span]);
    expect(out.resource.attributes['cloud.platform']).toBeUndefined();
    expect(out.resource.attributes['cloud.provider']).toBeUndefined();
    expect(out.resource.attributes['cloud.region']).toBeUndefined();
    expect(out.resource.attributes['faas.max_memory']).toBeUndefined();
    expect(out.resource.attributes['telemetry.sdk.name']).toBeUndefined();
    expect(out.resource.attributes['telemetry.sdk.version']).toBeUndefined();
    expect(out.resource.attributes['telemetry.sdk.language']).toBeUndefined();
    expect(out.resource.attributes['telemetry.sdk.build.node_version']).toBeUndefined();
    expect(out.resource.attributes['service.name']).toBe('rf-mcp-cache-sync');
    expect(out.resource.attributes['launchdarkly.project_id']).toBe('key');
  });

  it('handles a span whose attributes contain only noise (resource enrichment still applies)', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 's',
      resource: baseResource,
      attributes: { 'cloud.platform': 'cloudflare.workers' },
    };
    const [out] = injector([span]);
    expect(out.attributes['cloud.platform']).toBeUndefined();
    expect(out.resource.attributes['launchdarkly.project_id']).toBe('key');
  });
});

describe('makeLdResourceInjector — flow.name promotion to span.name', () => {
  it('overrides span.name with flow.name attribute when present', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'scheduledHandler */15 * * * *',
      resource: baseResource,
      attributes: { 'flow.name': 'CronTailSync' },
    };
    const [out] = injector([span]);
    expect(out.name).toBe('CronTailSync');
    expect(out.attributes['flow.name']).toBe('CronTailSync');
  });

  it('preserves original span.name when flow.name is not set', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'fetch GET api.example.com',
      resource: baseResource,
      attributes: { 'http.method': 'GET' },
    };
    const [out] = injector([span]);
    expect(out.name).toBe('fetch GET api.example.com');
  });

  it('overrides span.name on a frozen span via wrapper path', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const frozenSpan = Object.freeze({
      name: 'cache.cron.tick',
      resource: baseResource,
      attributes: { 'flow.name': 'CronCandidatesTick' },
    });
    const [out] = injector([frozenSpan]);
    expect(out.name).toBe('CronCandidatesTick');
    expect(out.attributes['flow.name']).toBe('CronCandidatesTick');
  });

  it('ignores empty-string flow.name (preserves original span.name)', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'fetch /foo',
      resource: baseResource,
      attributes: { 'flow.name': '' },
    };
    const [out] = injector([span]);
    expect(out.name).toBe('fetch /foo');
  });

  it('ignores non-string flow.name (preserves original span.name)', () => {
    const injector = makeLdResourceInjector('key');
    const baseResource = resourceFromAttributes({ 'service.name': 'test' });
    const span = {
      name: 'fetch /foo',
      resource: baseResource,
      attributes: { 'flow.name': 123 },
    };
    const [out] = injector([span]);
    expect(out.name).toBe('fetch /foo');
  });
});
