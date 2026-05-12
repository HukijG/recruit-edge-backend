import {
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { makeLdResourceInjector } from './ld-resource-injector.js';

const DEFAULT_LD_OTLP_TRACES_URL = 'https://otel.observability.app.launchdarkly.com/v1/traces';

/**
 * Per-path head sampler. For each root span, dispatches to a
 * TraceIdRatioBasedSampler keyed by the inbound URL path. Trace-ID-based ratio
 * keeps decisions deterministic across child spans (every span in a trace
 * inherits the parent's decision via ParentBasedSampler).
 *
 * Use case: very-high-volume polling endpoints (e.g. /extension-call-status,
 * fired ~500ms during an active Dialpad call) that would otherwise dominate
 * span volume in LD. We keep 10% as a sanity signal, drop the rest at head
 * time so we don't even record child spans for sampled-out polls.
 *
 * @param {Object<string, number>} rules
 *   { '/path': ratio, default: ratio }. Exact path match (no globbing).
 *   `default` is required.
 */
export class PathRatioSampler {
  constructor(rules) {
    if (!rules || typeof rules.default !== 'number') {
      throw new Error('PathRatioSampler: rules.default (number) is required');
    }
    this.rules = rules;
    this.samplers = new Map();
    for (const [path, ratio] of Object.entries(rules)) {
      this.samplers.set(path, new TraceIdRatioBasedSampler(ratio));
    }
  }
  shouldSample(ctx, traceId, spanName, spanKind, attributes, links) {
    // @microlabs's fetchHandler instrumentation stamps the inbound URL attrs
    // before invoking the sampler. `url.path` is the canonical OTel HTTP
    // semantic-conv key; `http.target` is the legacy fallback.
    const urlPath = attributes?.['url.path'] ?? attributes?.['http.target'] ?? '';
    const sampler = this.samplers.get(urlPath) ?? this.samplers.get('default');
    return sampler.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
  }
  toString() {
    return `PathRatioSampler(${JSON.stringify(this.rules)})`;
  }
}

/**
 * Per-route sampling rules for the main worker. Volume-vs-signal trade-off
 * per route. Add new entries here when a new high-volume route lands; the
 * default (1.0) catches anything unlisted.
 */
const PATH_SAMPLING_RULES = {
  '/extension-call-status': 0.1,  // polled ~every 500ms during active calls
  default: 1.0,
};

export function resolveOtelConfig(env, _trigger) {
  if (!env.LD_SDK_KEY) {
    throw new Error('resolveOtelConfig: env.LD_SDK_KEY is required');
  }
  const root = new PathRatioSampler(PATH_SAMPLING_RULES);
  // ParentBased wraps the root so cross-worker traces (service binding from
  // rf-mcp-remote, etc.) propagate the upstream head decision instead of
  // re-rolling per-span.
  const headSampler = new ParentBasedSampler({ root });

  return {
    service: { name: 'rf-dialpad-sync-dev' },
    exporter: {
      url: env.LD_OTLP_TRACES_URL || DEFAULT_LD_OTLP_TRACES_URL,
      headers: {},
    },
    postProcessor: makeLdResourceInjector(env.LD_SDK_KEY),
    sampling: {
      headSampler,
    },
    instrumentation: {
      instrumentGlobalFetch: true,
      instrumentGlobalCache: true,
    },
    // Note: handlers.fetch.acceptTraceContext (inbound) and top-level fetch.includeTraceContext (outbound)
    // both default to true, which is what we want. Omitting them keeps the config minimal.
  };
}

// Re-exported for tests and any callers that need the raw decision constants.
export { SamplingDecision };
