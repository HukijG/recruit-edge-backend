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

async function runTick(env: Env): Promise<{ ok: boolean; durationMs: number; d1Count: number; kvCount: number; aiNeurons: number | null; error?: string }> {
  console.log({ source: 'metrics-poller', message: 'tick start' });
  const t0 = Date.now();
  try {
    const metrics = await fetchCFMetrics(env);
    await pushOTelMetrics(env, metrics);
    const result = {
      ok: true,
      durationMs: Date.now() - t0,
      d1Count: metrics.d1Storage.length,
      kvCount: metrics.kvStorage.length,
      aiNeurons: metrics.aiUsage?.neurons ?? null,
    };
    console.log({ source: 'metrics-poller', message: 'tick ok', ...result });
    return result;
  } catch (err) {
    console.error({ source: 'metrics-poller', message: 'tick failed', error: String(err) });
    return { ok: false, durationMs: Date.now() - t0, d1Count: 0, kvCount: 0, aiNeurons: null, error: String(err) };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) {
    let dummy = 0;
    for (let i = 0; i < ea.length; i++) dummy |= ea[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

const handler = {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.CRON_METRICS_TICK);
    await runTick(env);
  },

  /**
   * Manual-trigger endpoint for smoke-testing the cron path without waiting
   * for the next top-of-hour. Auth-gated by X-Test-Token: env.CF_API_TOKEN
   * (constant-time compare). Returns the same shape `runTick` returns so
   * the caller can verify GraphQL + OTLP push results inline.
   *
   * Same auth secret as the upstream GraphQL call so no extra secret needs
   * provisioning. The token surface is identical to what's already on the
   * wire to CF GraphQL — no incremental exposure.
   */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/__test-trigger') {
      return new Response('not found', { status: 404 });
    }
    const token = request.headers.get('X-Test-Token');
    if (!env.CF_API_TOKEN || !token || !timingSafeEqual(token, env.CF_API_TOKEN)) {
      return new Response('unauthorized', { status: 401 });
    }
    trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.CRON_METRICS_TICK);
    const result = await runTick(env);
    return Response.json(result, { status: result.ok ? 200 : 500 });
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
