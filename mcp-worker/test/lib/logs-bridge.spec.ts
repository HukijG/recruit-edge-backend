import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const emitMock = vi.fn();
const setProviderMock = vi.fn();

vi.mock('@opentelemetry/api-logs', () => ({
  logs: {
    setGlobalLoggerProvider: setProviderMock,
    getLogger: () => ({ emit: emitMock }),
  },
  SeverityNumber: { INFO: 9, WARN: 13, ERROR: 17 },
}));

vi.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: vi.fn().mockImplementation(function (this: any, opts: any) { this.opts = opts; }),
  BatchLogRecordProcessor: vi.fn().mockImplementation(function (this: any, exporter: any, opts: any) { this.exporter = exporter; this.opts = opts; }),
}));

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: vi.fn().mockImplementation(function (this: any, opts: any) { this.opts = opts; }),
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn((attrs: any) => ({ attributes: attrs })),
}));

vi.mock('cloudflare:workers', () => ({
  env: { LD_SDK_KEY: 'test-sdk-key' },
}));

let installLogsBridge: (serviceName?: string) => void;
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;

describe('logs-bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    emitMock.mockClear();
    setProviderMock.mockClear();
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    ({ installLogsBridge } = await import('../../src/lib/logs-bridge.js'));
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
    const circular: any = { name: 'x' };
    circular.self = circular;
    expect(() => console.log(circular)).not.toThrow();
  });

  it('is idempotent — calling install twice does not re-register', () => {
    installLogsBridge('test-service');
    setProviderMock.mockClear();
    installLogsBridge('test-service');
    expect(setProviderMock).not.toHaveBeenCalled();
  });
});
