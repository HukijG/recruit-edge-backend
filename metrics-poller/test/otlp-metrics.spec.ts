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
      aiUsage: {
        neurons: 100,
        inferenceSteps: 12,
        inputTokens: 5000,
        outputTokens: 800,
        requests: 7,
      },
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
    const metricsBlock = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const metricNames = metricsBlock.map((m: any) => m.name);
    expect(metricNames).toContain('cf.d1.storage_bytes');
    expect(metricNames).toContain('cf.kv.stored_bytes');
    expect(metricNames).toContain('cf.ai.neurons');
    expect(metricNames).toContain('cf.ai.inference_steps');
    expect(metricNames).toContain('cf.ai.input_tokens');
    expect(metricNames).toContain('cf.ai.output_tokens');
    expect(metricNames).toContain('cf.ai.requests');
    // `cf.ai.usage` was the old vague name pre-schema-verification — make sure
    // we don't accidentally regress to it.
    expect(metricNames).not.toContain('cf.ai.usage');

    // Each AI metric carries the right value from the aggregated usage shape.
    const neuronsMetric = metricsBlock.find((m: any) => m.name === 'cf.ai.neurons');
    expect(neuronsMetric.gauge.dataPoints[0].asInt).toBe('100');
    expect(neuronsMetric.unit).toBe('{neuron}');
    const stepsMetric = metricsBlock.find((m: any) => m.name === 'cf.ai.inference_steps');
    expect(stepsMetric.gauge.dataPoints[0].asInt).toBe('12');
    const inputTokensMetric = metricsBlock.find((m: any) => m.name === 'cf.ai.input_tokens');
    expect(inputTokensMetric.gauge.dataPoints[0].asInt).toBe('5000');
    const outputTokensMetric = metricsBlock.find((m: any) => m.name === 'cf.ai.output_tokens');
    expect(outputTokensMetric.gauge.dataPoints[0].asInt).toBe('800');
    const requestsMetric = metricsBlock.find((m: any) => m.name === 'cf.ai.requests');
    expect(requestsMetric.gauge.dataPoints[0].asInt).toBe('7');

    // CF_ACCOUNT_ID threads through to resource attributes on data points
    const d1Metric = metricsBlock.find((m: any) => m.name === 'cf.d1.storage_bytes');
    const accountAttr = d1Metric.gauge.dataPoints[0].attributes.find((a: any) => a.key === 'cf.account_id');
    expect(accountAttr.value.stringValue).toBe('account-id-xyz');
  });

  it('emits empty AI dataPoints when aiUsage is null', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
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

    const body = JSON.parse((fetchSpy as any).mock.calls[0][1].body);
    const metricsBlock = body.resourceMetrics[0].scopeMetrics[0].metrics;
    for (const name of ['cf.ai.neurons', 'cf.ai.inference_steps', 'cf.ai.input_tokens', 'cf.ai.output_tokens', 'cf.ai.requests']) {
      const m = metricsBlock.find((x: any) => x.name === name);
      expect(m.gauge.dataPoints).toEqual([]);
    }
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

  it('encodes fractional values via asDouble (LD rejects asInt strings with decimal points)', async () => {
    // Live regression: CF GraphQL returns totalNeurons as a float (e.g. 12082.193518913959).
    // The OTLP/JSON spec for NumberDataPoint allows asInt (string-form int64) OR asDouble
    // (JSON number). LD's ingester does strconv.ParseInt on asInt — passing a float like
    // "12082.193518913959" via asInt produces a 400 error and the WHOLE payload is rejected
    // (so d1/kv metrics ALSO stop landing). Float → asDouble, integer → asInt.
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy as any;

    await pushOTelMetrics({
      LD_OTLP_METRICS_URL: 'https://x/v1/metrics',
      LD_SDK_KEY: 'test-key',
      CF_ACCOUNT_ID: 'account-id-xyz',
    }, {
      d1Storage: [{ databaseId: 'db-int', sizeBytes: 95617020 }],
      kvStorage: [],
      aiUsage: {
        neurons: 12082.193518913959,  // ← float
        inferenceSteps: 0,
        inputTokens: 342199,           // ← int
        outputTokens: 14829,           // ← int
        requests: 347,                  // ← int
      },
    });

    const body = JSON.parse((fetchSpy as any).mock.calls[0][1].body);
    const metricsBlock = body.resourceMetrics[0].scopeMetrics[0].metrics;

    // Neurons must be asDouble (number), NOT asInt (string)
    const neuronsDp = metricsBlock.find((m: any) => m.name === 'cf.ai.neurons').gauge.dataPoints[0];
    expect(neuronsDp.asDouble).toBe(12082.193518913959);
    expect(neuronsDp.asInt).toBeUndefined();

    // Integer-valued AI metrics still asInt (string)
    const tokensDp = metricsBlock.find((m: any) => m.name === 'cf.ai.input_tokens').gauge.dataPoints[0];
    expect(tokensDp.asInt).toBe('342199');
    expect(tokensDp.asDouble).toBeUndefined();

    // D1 byte counts are integers → asInt
    const d1Dp = metricsBlock.find((m: any) => m.name === 'cf.d1.storage_bytes').gauge.dataPoints[0];
    expect(d1Dp.asInt).toBe('95617020');
    expect(d1Dp.asDouble).toBeUndefined();

    // No errors logged on a successful push
    expect(errSpy).not.toHaveBeenCalled();
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
