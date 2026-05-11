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

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
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
