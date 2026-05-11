import { env as workerEnv } from 'cloudflare:workers';
import { installBodyCapture } from './lib/body-capture.js';
import { installLogsBridge } from './lib/logs-bridge.js';

installBodyCapture();
installLogsBridge('rf-cf-metrics-poller');

import { instrument } from '@microlabs/otel-cf-workers';
import { resolveOtelConfig } from './lib/otel-config.js';
import { trace } from '@opentelemetry/api';
import { fetchCFMetrics } from './cf-graphql.js';
import { pushOTelMetrics } from './otlp-metrics.js';
import { FLOWS } from './lib/flow-names.js';

interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_GRAPHQL_ENDPOINT: string;
  LD_SDK_KEY: string;
  LD_OTLP_METRICS_URL: string;
}

const handler = {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.CRON_METRICS_TICK);
    console.log({ source: 'metrics-poller', message: 'tick start' });
    const t0 = Date.now();
    try {
      const metrics = await fetchCFMetrics(env);
      await pushOTelMetrics(env, metrics);
      console.log({
        source: 'metrics-poller',
        message: 'tick ok',
        d1_count: metrics.d1Storage.length,
        kv_count: metrics.kvStorage.length,
        ai_neurons: metrics.aiUsage?.neurons ?? null,
        duration_ms: Date.now() - t0,
      });
    } catch (err) {
      console.error({ source: 'metrics-poller', message: 'tick failed', error: String(err) });
    }
  },
};

// `instrument()` is the production wiring. In environments where `LD_SDK_KEY` is
// absent (e.g. the vitest harness), we export the raw handler so the cron path
// never touches the OTLP exporters. The lib `installLogsBridge` already
// self-skips on missing key; this mirrors that semantic at the handler layer.
// Same pattern as main + sync + mcp workers.
export default (workerEnv as unknown as { LD_SDK_KEY?: string }).LD_SDK_KEY
  ? instrument(handler, resolveOtelConfig)
  : handler;
