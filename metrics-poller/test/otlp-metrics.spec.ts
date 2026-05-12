import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pushOTelMetrics } from '../src/otlp-metrics.js';

describe('pushOTelMetrics', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('builds and POSTs an OTLP ResourceMetrics payload with launchdarkly.project_id', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy as any;

    await pushOTelMetrics({
      LD_OTLP_METRICS_URL: 'https://x/v1/metrics',
      LD_SDK_KEY: 'test-key',
      CF_ACCOUNT_ID: 'account-id-xyz',
    }, {
      d1Storage: [{ databaseId: 'rf-mcp-cache', sizeBytes: 12345 }],
      kvStorage: [{ namespaceId: 'SYNC_STATE', byteCount: 9876, keyCount: 42 }],
      aiUsage: { neurons: 100 },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as any).mock.calls[0];
    expect(url).toBe('https://x/v1/metrics');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    const resource = body.resourceMetrics[0].resource;
    const projectIdAttr = resource.attributes.find((a: any) => a.key === 'launchdarkly.project_id');
    expect(projectIdAttr.value.stringValue).toBe('test-key');
    const metricNames = body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => m.name);
    expect(metricNames).toContain('cf.d1.storage_bytes');
    expect(metricNames).toContain('cf.kv.stored_bytes');
    expect(metricNames).toContain('cf.ai.usage');

    // CF_ACCOUNT_ID threads through to resource attributes on data points
    const d1Metric = body.resourceMetrics[0].scopeMetrics[0].metrics.find((m: any) => m.name === 'cf.d1.storage_bytes');
    const accountAttr = d1Metric.gauge.dataPoints[0].attributes.find((a: any) => a.key === 'cf.account_id');
    expect(accountAttr.value.stringValue).toBe('account-id-xyz');
  });

  it('logs an error when LD returns a non-2xx status', async () => {
    const fetchSpy = vi.fn(async () => new Response('boom', { status: 500 }));
    globalThis.fetch = fetchSpy as any;

    await pushOTelMetrics({
      LD_OTLP_METRICS_URL: 'https://x/v1/metrics',
      LD_SDK_KEY: 'test-key',
      CF_ACCOUNT_ID: 'account-id-xyz',
    }, {
      d1Storage: [],
      kvStorage: [],
      aiUsage: null,
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0][0] as any;
    expect(logged.source).toBe('metrics-poller');
    expect(logged.message).toBe('OTLP push HTTP error');
    expect(logged.status).toBe(500);
  });

  it('logs an error when fetch throws (network)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('connect refused'); }) as any;

    await pushOTelMetrics({
      LD_OTLP_METRICS_URL: 'https://x/v1/metrics',
      LD_SDK_KEY: 'test-key',
      CF_ACCOUNT_ID: 'account-id-xyz',
    }, {
      d1Storage: [],
      kvStorage: [],
      aiUsage: null,
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0][0] as any;
    expect(logged.source).toBe('metrics-poller');
    expect(logged.message).toBe('OTLP push failed (network)');
    expect(String(logged.error)).toContain('connect refused');
  });

  it('throws if CF_ACCOUNT_ID is missing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as any;
    await expect(pushOTelMetrics({
      LD_OTLP_METRICS_URL: 'https://x/v1/metrics',
      LD_SDK_KEY: 'test-key',
      CF_ACCOUNT_ID: '',
    }, {
      d1Storage: [],
      kvStorage: [],
      aiUsage: null,
    })).rejects.toThrow(/CF_ACCOUNT_ID/);
  });
});
