import { makeLdResourceInjector } from './ld-resource-injector.js';

const DEFAULT_LD_OTLP_TRACES_URL = 'https://otel.observability.app.launchdarkly.com/v1/traces';

export function resolveOtelConfig(env, _trigger) {
  if (!env.LD_SDK_KEY) {
    throw new Error('resolveOtelConfig: env.LD_SDK_KEY is required');
  }
  return {
    service: { name: 'rf-dialpad-sync-dev' },
    exporter: {
      url: env.LD_OTLP_TRACES_URL || DEFAULT_LD_OTLP_TRACES_URL,
      headers: {},
    },
    postProcessor: makeLdResourceInjector(env.LD_SDK_KEY),
    sampling: {
      headSampler: { ratio: 1, acceptRemote: true },
    },
    instrumentation: {
      instrumentGlobalFetch: true,
      instrumentGlobalCache: true,
    },
    // Note: handlers.fetch.acceptTraceContext (inbound) and top-level fetch.includeTraceContext (outbound)
    // both default to true, which is what we want. Omitting them keeps the config minimal.
  };
}
