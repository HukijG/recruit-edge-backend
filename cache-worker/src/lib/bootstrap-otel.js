import { env } from 'cloudflare:workers';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { trace as noopTraceApi } from '@opentelemetry/api';

const DEFAULT_LD_OTLP_TRACES_URL = 'https://otel.observability.app.launchdarkly.com/v1/traces';

let _provider = null;
let _initialized = false;

/**
 * Lazily construct + cache a local BasicTracerProvider for Workflow contexts.
 * Workflows are invoked by the Workflow runtime outside the fetch/scheduled
 * entry, so @microlabs's instrument() wrap doesn't reach them — they need
 * their own provider to emit spans to LaunchDarkly.
 *
 * This function INTENTIONALLY DOES NOT call trace.setGlobalTracerProvider().
 * That would clobber @microlabs's WorkerTracerProvider registration for
 * fetch/scheduled handlers (the @opentelemetry/api singleton rejects duplicate
 * registrations — first writer wins, so we'd silently win and break export).
 */
export function getWorkflowTracerProvider(serviceName) {
  if (_initialized) return _provider;
  _initialized = true;

  if (!env.LD_SDK_KEY) {
    console.error({ source: 'bootstrap-otel', message: 'LD_SDK_KEY missing; Workflow traces will not export' });
    return null;
  }

  const resource = resourceFromAttributes({
    'service.name': serviceName,
    'launchdarkly.project_id': env.LD_SDK_KEY,
    'cloud.provider': 'cloudflare',
    'cloud.platform': 'cloudflare.workers',
  });

  const exporter = new OTLPTraceExporter({
    url: env.LD_OTLP_TRACES_URL || DEFAULT_LD_OTLP_TRACES_URL,
    headers: {},
  });

  _provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  return _provider;
}

/**
 * Returns a Tracer from the local Workflow provider. Falls back to the
 * @opentelemetry/api no-op tracer if LD_SDK_KEY is missing.
 */
export function getWorkflowTracer(serviceName, tracerName) {
  const provider = getWorkflowTracerProvider(serviceName);
  if (!provider) return noopTraceApi.getTracer(tracerName || serviceName);
  return provider.getTracer(tracerName || serviceName);
}

/**
 * Force-flush queued spans through the local Workflow provider. MUST be
 * awaited at the end of a Workflow.run() body — Workflow contexts have no
 * ctx.waitUntil, and the BatchSpanProcessor's scheduled flush will not fire
 * before the run context tears down.
 */
export function flushWorkflowSpans() {
  if (!_provider) return Promise.resolve();
  return _provider.forceFlush();
}
