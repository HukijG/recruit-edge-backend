import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const emitMock = vi.fn();
const setProviderMock = vi.fn();
const forceFlushMock = vi.fn(() => Promise.resolve());

vi.mock('@opentelemetry/api-logs', () => ({
  logs: {
    setGlobalLoggerProvider: setProviderMock,
    getLogger: () => ({ emit: emitMock }),
  },
  SeverityNumber: { INFO: 9, WARN: 13, ERROR: 17 },
}));

vi.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: vi.fn().mockImplementation(function (opts) {
    this.opts = opts;
    this.forceFlush = forceFlushMock;
  }),
  BatchLogRecordProcessor: vi.fn().mockImplementation(function (exporter, opts) { this.exporter = exporter; this.opts = opts; }),
}));

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: vi.fn().mockImplementation(function (opts) { this.opts = opts; }),
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn((attrs) => ({ attributes: attrs })),
}));

vi.mock('cloudflare:workers', () => ({
  env: { LD_SDK_KEY: 'test-sdk-key' },
}));

let installLogsBridge;
let flushLogs;
let withLogsFlush;
let originalConsoleLog;
let originalConsoleError;

describe('logs-bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Re-establish the canonical cloudflare:workers mock — earlier tests that
    // use vi.doMock to flip OTEL_DISABLED / drop LD_SDK_KEY leave a sticky
    // override behind that would otherwise poison subsequent tests.
    vi.doMock('cloudflare:workers', () => ({ env: { LD_SDK_KEY: 'test-sdk-key' } }));
    emitMock.mockClear();
    setProviderMock.mockClear();
    forceFlushMock.mockClear();
    forceFlushMock.mockImplementation(() => Promise.resolve());
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    ({ installLogsBridge, flushLogs, withLogsFlush } = await import('../../src/lib/logs-bridge.js'));
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('installs without throwing', () => {
    expect(() => installLogsBridge('test-service')).not.toThrow();
  });

  it('registers the global LoggerProvider once', () => {
    installLogsBridge('test-service');
    expect(setProviderMock).toHaveBeenCalledTimes(1);
  });

  it('single-object form console.log emits structured log record', () => {
    installLogsBridge('test-service');
    console.log({ source: 'rf', message: 'fetched candidate', candidate_id: 12345 });
    expect(emitMock).toHaveBeenCalledTimes(1);
    const arg = emitMock.mock.calls[0][0];
    expect(arg.severityNumber).toBe(9);
    expect(arg.severityText).toBe('INFO');
    expect(arg.body).toBe('fetched candidate');
    expect(arg.attributes.source).toBe('rf');
    expect(arg.attributes.candidate_id).toBe(12345);
  });

  it('console.error emits with severity ERROR', () => {
    installLogsBridge('test-service');
    console.error({ source: 'rf', message: 'failed' });
    const arg = emitMock.mock.calls[0][0];
    expect(arg.severityNumber).toBe(17);
    expect(arg.severityText).toBe('ERROR');
  });

  it('Error instance produces exception.type and exception.stacktrace attributes', () => {
    installLogsBridge('test-service');
    const err = new TypeError('boom');
    console.error(err);
    const arg = emitMock.mock.calls[0][0];
    expect(arg.body).toBe('boom');
    expect(arg.attributes['exception.type']).toBe('TypeError');
    expect(arg.attributes['exception.stacktrace']).toContain('TypeError');
  });

  it('positional args fall back to joined body', () => {
    installLogsBridge('test-service');
    console.log('about to call rf for', 'candidate', 12345);
    const arg = emitMock.mock.calls[0][0];
    expect(arg.body).toContain('about to call rf for');
    expect(arg.body).toContain('candidate');
    expect(arg.body).toContain('12345');
  });

  it('emit never throws on circular references', () => {
    installLogsBridge('test-service');
    const circular = { name: 'x' };
    circular.self = circular;
    expect(() => console.log(circular)).not.toThrow();
  });

  it('is idempotent — calling install twice does not re-register', () => {
    installLogsBridge('test-service');
    setProviderMock.mockClear();
    installLogsBridge('test-service');
    expect(setProviderMock).not.toHaveBeenCalled();
  });

  it('OTEL_DISABLED=1 short-circuits before registering or wrapping console.*', async () => {
    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: { LD_SDK_KEY: 'test-sdk-key', OTEL_DISABLED: '1' } }));
    setProviderMock.mockClear();
    emitMock.mockClear();
    const mod = await import('../../src/lib/logs-bridge.js');
    mod.installLogsBridge('test-service');
    // No provider was registered, and calling console.log produces no emit (wrap was never installed).
    expect(setProviderMock).not.toHaveBeenCalled();
    console.log('would normally emit');
    console.error('would normally emit error');
    expect(emitMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // flushLogs / withLogsFlush — flush-before-worker-termination guard
  //
  // BatchLogRecordProcessor's 1s scheduled flush doesn't fire before fast
  // handlers terminate; without an explicit forceFlush, queued log records
  // never reach LaunchDarkly. flushLogs() exposes the provider's forceFlush,
  // and withLogsFlush() wraps the handler so the flush is queued in
  // ctx.waitUntil after handler-side waitUntils complete.
  // -------------------------------------------------------------------------

  it('flushLogs() — with provider installed, calls provider.forceFlush', async () => {
    installLogsBridge('test-service');
    await flushLogs();
    expect(forceFlushMock).toHaveBeenCalledTimes(1);
  });

  it('flushLogs() — never throws if forceFlush itself throws (telemetry safety)', async () => {
    installLogsBridge('test-service');
    forceFlushMock.mockImplementationOnce(() => { throw new Error('export network down'); });
    await expect(flushLogs()).resolves.toBeUndefined();
  });

  it('withLogsFlush returns an object with fetch when input has fetch', () => {
    const wrapped = withLogsFlush({ fetch: async () => new Response('ok') });
    expect(typeof wrapped.fetch).toBe('function');
    expect(wrapped.scheduled).toBeUndefined();
    expect(wrapped.queue).toBeUndefined();
  });

  it('withLogsFlush returns scheduled when input has scheduled', () => {
    const wrapped = withLogsFlush({ scheduled: async () => {} });
    expect(typeof wrapped.scheduled).toBe('function');
    expect(wrapped.fetch).toBeUndefined();
  });

  it('withLogsFlush returns queue when input has queue', () => {
    const wrapped = withLogsFlush({ queue: async () => {} });
    expect(typeof wrapped.queue).toBe('function');
  });

  it('withLogsFlush(handler).fetch registers ctx.waitUntil for the flush', async () => {
    installLogsBridge('test-service');
    forceFlushMock.mockClear();
    const handler = { fetch: async () => new Response('ok') };
    const wrapped = withLogsFlush(handler);
    const waitUntilCalls = [];
    const ctx = { waitUntil: vi.fn((p) => { waitUntilCalls.push(p); }) };
    const res = await wrapped.fetch(new Request('https://x'), {}, ctx);
    expect(res).toBeInstanceOf(Response);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    // Awaiting the queued promise ensures the inner flushLogs() has resolved.
    await Promise.all(waitUntilCalls);
    expect(forceFlushMock).toHaveBeenCalledTimes(1);
  });

  it('withLogsFlush ctx proxy tracks inner ctx.waitUntil promises before flushing', async () => {
    installLogsBridge('test-service');
    let innerResolved = false;
    const innerPromise = new Promise((r) => setTimeout(() => { innerResolved = true; r(); }, 25));
    const handler = {
      fetch: async (_req, _env, ctx) => {
        ctx.waitUntil(innerPromise);
        return new Response('ok');
      },
    };
    const wrapped = withLogsFlush(handler);
    const waitUntilCalls = [];
    const realCtx = { waitUntil: vi.fn((p) => { waitUntilCalls.push(p); }) };
    forceFlushMock.mockImplementation(() => {
      // When forceFlush is called, the tracked inner promise must already be settled.
      expect(innerResolved).toBe(true);
      return Promise.resolve();
    });
    await wrapped.fetch(new Request('https://x'), {}, realCtx);
    // Two waitUntil registrations: the inner promise + the flush-after-tracker promise.
    expect(realCtx.waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(waitUntilCalls);
    expect(forceFlushMock).toHaveBeenCalledTimes(1);
  });

  it('withLogsFlush still flushes if the handler throws (finally semantics)', async () => {
    installLogsBridge('test-service');
    const handler = {
      fetch: async () => { throw new Error('handler boom'); },
    };
    const wrapped = withLogsFlush(handler);
    const waitUntilCalls = [];
    const ctx = { waitUntil: vi.fn((p) => { waitUntilCalls.push(p); }) };
    forceFlushMock.mockClear();
    await expect(wrapped.fetch(new Request('https://x'), {}, ctx)).rejects.toThrow('handler boom');
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntilCalls);
    expect(forceFlushMock).toHaveBeenCalledTimes(1);
  });

  it('withLogsFlush.scheduled also flushes via ctx.waitUntil', async () => {
    installLogsBridge('test-service');
    const handler = { scheduled: async () => {} };
    const wrapped = withLogsFlush(handler);
    const waitUntilCalls = [];
    const ctx = { waitUntil: vi.fn((p) => { waitUntilCalls.push(p); }) };
    forceFlushMock.mockClear();
    await wrapped.scheduled({ cron: '* * * * *' }, {}, ctx);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntilCalls);
    expect(forceFlushMock).toHaveBeenCalledTimes(1);
  });

  // NOTE: keep this LAST — uses vi.doMock to override cloudflare:workers, which
  // persists across imports. The beforeEach above resets the canonical mock for
  // each test, so this ordering is for clarity rather than necessity.
  it('flushLogs() — no provider (LD_SDK_KEY missing) returns resolved Promise', async () => {
    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: {} }));
    forceFlushMock.mockClear();
    const mod = await import('../../src/lib/logs-bridge.js');
    mod.installLogsBridge('test-service');
    await expect(mod.flushLogs()).resolves.toBeUndefined();
    expect(forceFlushMock).not.toHaveBeenCalled();
  });
});
