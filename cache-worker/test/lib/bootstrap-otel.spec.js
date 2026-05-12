import { describe, it, expect, beforeEach, vi } from 'vitest';

const { setGlobalTracerProviderMock, forceFlushMock, getTracerMock, noopGetTracerMock } = vi.hoisted(() => ({
  setGlobalTracerProviderMock: vi.fn(),
  forceFlushMock: vi.fn(() => Promise.resolve()),
  getTracerMock: vi.fn(() => ({
    startActiveSpan: vi.fn(async (_name, _opts, fn) => fn({
      setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn(), end: vi.fn(),
    })),
  })),
  noopGetTracerMock: vi.fn(() => ({
    startActiveSpan: vi.fn(async (_name, _opts, fn) => fn({
      setAttribute: vi.fn(), recordException: vi.fn(), setStatus: vi.fn(), end: vi.fn(),
    })),
  })),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    setGlobalTracerProvider: setGlobalTracerProviderMock,
    getTracer: noopGetTracerMock,
  },
}));
vi.mock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: vi.fn().mockImplementation(function (opts) {
    this.opts = opts;
    this.getTracer = getTracerMock;
    this.forceFlush = forceFlushMock;
  }),
  BatchSpanProcessor: vi.fn().mockImplementation(function (exporter) { this.exporter = exporter; }),
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(function (opts) { this.opts = opts; }),
}));
vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn((attrs) => ({ attributes: attrs })),
}));

let envObj;
vi.mock('cloudflare:workers', () => ({
  get env() { return envObj; },
}));

let getWorkflowTracer, getWorkflowTracerProvider, flushWorkflowSpans;

describe('bootstrap-otel (Workflow-local TracerProvider)', () => {
  beforeEach(async () => {
    vi.resetModules();
    setGlobalTracerProviderMock.mockClear();
    forceFlushMock.mockClear();
    getTracerMock.mockClear();
    noopGetTracerMock.mockClear();
    envObj = { LD_SDK_KEY: 'test-sdk-key' };
    ({ getWorkflowTracer, getWorkflowTracerProvider, flushWorkflowSpans } = await import('../../src/lib/bootstrap-otel.js'));
  });

  it('NEVER calls trace.setGlobalTracerProvider (load-bearing — would clobber @microlabs)', () => {
    getWorkflowTracer('test-service');
    getWorkflowTracerProvider('test-service');
    flushWorkflowSpans();
    expect(setGlobalTracerProviderMock).toHaveBeenCalledTimes(0);
  });

  it('getWorkflowTracerProvider is lazy and cached', () => {
    const p1 = getWorkflowTracerProvider('test-service');
    const p2 = getWorkflowTracerProvider('test-service');
    expect(p1).toBe(p2);
    // BasicTracerProvider constructor only called once across both calls
    // (confirmed via cache hit returning same instance reference).
  });

  it('getWorkflowTracer returns a tracer with startActiveSpan', () => {
    const t = getWorkflowTracer('test-service', 'test-tracer');
    expect(typeof t.startActiveSpan).toBe('function');
  });

  it('flushWorkflowSpans returns a Promise that resolves', async () => {
    getWorkflowTracerProvider('test-service');  // initialize
    const result = flushWorkflowSpans();
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(forceFlushMock).toHaveBeenCalledTimes(1);
  });

  it('LD_SDK_KEY missing — getWorkflowTracerProvider returns null', async () => {
    vi.resetModules();
    envObj = {};
    ({ getWorkflowTracer, getWorkflowTracerProvider, flushWorkflowSpans } =
      await import('../../src/lib/bootstrap-otel.js'));
    expect(getWorkflowTracerProvider('test-service')).toBeNull();
  });

  it('LD_SDK_KEY missing — getWorkflowTracer falls back to no-op @opentelemetry/api tracer', async () => {
    vi.resetModules();
    envObj = {};
    ({ getWorkflowTracer, getWorkflowTracerProvider, flushWorkflowSpans } =
      await import('../../src/lib/bootstrap-otel.js'));
    const t = getWorkflowTracer('test-service', 'test-tracer');
    expect(typeof t.startActiveSpan).toBe('function');
    expect(noopGetTracerMock).toHaveBeenCalled();
  });

  it('LD_SDK_KEY missing — flushWorkflowSpans resolves to Promise.resolve()', async () => {
    vi.resetModules();
    envObj = {};
    ({ getWorkflowTracer, getWorkflowTracerProvider, flushWorkflowSpans } =
      await import('../../src/lib/bootstrap-otel.js'));
    // initialize via getWorkflowTracerProvider — returns null with no key,
    // so flushWorkflowSpans should hit the early-return Promise.resolve() path.
    getWorkflowTracerProvider('test-service');
    const result = flushWorkflowSpans();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(forceFlushMock).toHaveBeenCalledTimes(0);
  });
});
