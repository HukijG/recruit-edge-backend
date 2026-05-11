import { describe, it, expect, vi } from 'vitest';
import { pushOTelMetrics } from '../src/otlp-metrics.js';

describe('pushOTelMetrics', () => {
  it('builds and POSTs an OTLP ResourceMetrics payload with launchdarkly.project_id', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy as any;

    await pushOTelMetrics({
      LD_OTLP_METRICS_URL: 'https://x/v1/metrics',
      LD_SDK_KEY: 'test-key',
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
  });
});
