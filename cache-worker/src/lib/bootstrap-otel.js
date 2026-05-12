import { env } from 'cloudflare:workers';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

const DEFAULT_LD_OTLP_TRACES_URL = 'https://otel.observability.app.launchdarkly.com/v1/traces';

let bootstrapped = false;

export function bootstrapOtelForWorkflows(serviceName) {
  if (bootstrapped) return;
  bootstrapped = true;

  if (!env.LD_SDK_KEY) {
    console.error({ source: 'bootstrap-otel', message: 'LD_SDK_KEY missing; Workflow traces will not export' });
    return;
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

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  trace.setGlobalTracerProvider(provider);
}
