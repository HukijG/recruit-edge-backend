import { describe, it, expect, beforeEach, vi } from 'vitest';

const { setGlobalTracerProviderMock } = vi.hoisted(() => ({
  setGlobalTracerProviderMock: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: { setGlobalTracerProvider: setGlobalTracerProviderMock },
}));
vi.mock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: vi.fn().mockImplementation(function (opts) { this.opts = opts; }),
  BatchSpanProcessor: vi.fn().mockImplementation(function (exporter) { this.exporter = exporter; }),
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(function (opts) { this.opts = opts; }),
}));
vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn((attrs) => ({ attributes: attrs })),
}));
vi.mock('cloudflare:workers', () => ({
  env: { LD_SDK_KEY: 'test-sdk-key' },
}));

let bootstrapOtelForWorkflows;

describe('bootstrapOtelForWorkflows', () => {
  beforeEach(async () => {
    vi.resetModules();
    setGlobalTracerProviderMock.mockClear();
    ({ bootstrapOtelForWorkflows } = await import('../../src/lib/bootstrap-otel.js'));
  });

  it('registers a global TracerProvider', () => {
    bootstrapOtelForWorkflows('rf-mcp-cache-sync');
    expect(setGlobalTracerProviderMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent', () => {
    bootstrapOtelForWorkflows('rf-mcp-cache-sync');
    bootstrapOtelForWorkflows('rf-mcp-cache-sync');
    expect(setGlobalTracerProviderMock).toHaveBeenCalledTimes(1);
  });
});
