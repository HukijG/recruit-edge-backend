import { resourceFromAttributes } from '@opentelemetry/resources';

const REDACT_QUERY_PARAM = /secret|token|api[_-]?key|apikey/i;
const URL_ATTR_KEYS = ['url.full', 'url.query'];

// Attributes the SDKs auto-stamp but contribute zero debugging value for our
// single-account / single-runtime / single-region deployment. Pruned from both
// resource attributes (set once per export) and per-span attributes (set per
// request/span) before forwarding to LD. Adjust this set rather than per-call
// to avoid noise re-creep.
//
// faas.coldstart is intentionally KEPT — useful for cold-start latency
// debugging. server.address is KEPT — distinguishes outbound destinations.
// user_agent.original is KEPT — useful for identifying webhook sources.
const NOISE_KEYS = new Set([
  // @microlabs createResource resource attrs (always
  // cloudflare/cloudflare.workers/earth on this stack)
  'cloud.provider',
  'cloud.platform',
  'cloud.region',
  'faas.max_memory',
  'telemetry.sdk.language',
  'telemetry.sdk.name',
  'telemetry.sdk.version',
  'telemetry.sdk.build.node_version',
  // Per-span FaaS attrs that don't aid debugging
  'faas.invocation_id',
  'faas.trigger',
  // OTel HTTP semantic-conv noise — duplicates url.full or never useful
  'http.accepts',
  'http.accept_encoding',
  'http.accept-encoding',
  'network.protocol.name',
  'network.protocol.version',
  // CF request-origin metadata — interesting for traffic-pattern dashboards
  // but not for per-trace debugging
  'net.asn',
  'net.colo',
  'net.country',
  'net.tcp_rtt',
  'net.tls_cipher',
  'net.tls_version',
  // Sub-fields of url.full that don't add information
  'url.domain',
  'url.scheme',
  // LD-internal feature_flag stamp (not OUR feature flags — LD's own)
  'feature_flag.set.id',
]);

export function makeLdResourceInjector(sdkKey) {
  if (!sdkKey || typeof sdkKey !== 'string') {
    throw new Error('makeLdResourceInjector: LD_SDK_KEY is required (got: ' + typeof sdkKey + ')');
  }
  let cachedResource = null;

  return function postProcessor(spans) {
    if (!Array.isArray(spans) || spans.length === 0) return spans;

    if (!cachedResource) {
      const base = spans[0].resource;
      const filteredBase = pruneResourceNoise(base);
      const ldExtra = resourceFromAttributes({ 'launchdarkly.project_id': sdkKey });
      cachedResource = filteredBase && typeof filteredBase.merge === 'function' ? filteredBase.merge(ldExtra) : ldExtra;
    }

    return spans.map((span) => {
      const spanAttrs = span.attributes || {};
      const flowName = spanAttrs['flow.name'];
      const cleanedAttrs = computeCleanedAttributes(spanAttrs);
      const replacements = {
        resource: cachedResource,
        attributes: cleanedAttrs,
      };
      // Promote flow.name to the display name. LD groups its trace-tree view
      // by span.name; the @microlabs handler proxy stamps generic names like
      // "fetchHandler POST" or "scheduledHandler */15 * * * *". flow.name is
      // the human-readable identity we set on every entry handler — promote
      // it so the trace list reads as "WebhookDialpadExtensionCall" /
      // "CronTailSync" / etc. flow.name remains in attributes for filter
      // and groupBy queries.
      if (typeof flowName === 'string' && flowName.length > 0) {
        replacements.name = flowName;
      }
      return wrapSpanWithReplacements(span, replacements);
    });
  };
}

function pruneResourceNoise(resource) {
  if (!resource || !resource.attributes) return resource;
  let dropped = false;
  const filtered = {};
  for (const [k, v] of Object.entries(resource.attributes)) {
    if (NOISE_KEYS.has(k)) { dropped = true; continue; }
    filtered[k] = v;
  }
  return dropped ? resourceFromAttributes(filtered) : resource;
}

function computeCleanedAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  let changed = false;
  const next = {};
  // Prune noise keys; carry through everything else.
  for (const [k, v] of Object.entries(attrs)) {
    if (NOISE_KEYS.has(k)) { changed = true; continue; }
    next[k] = v;
  }
  // Apply URL query-param redaction on whitelisted URL keys.
  for (const key of URL_ATTR_KEYS) {
    const raw = next[key];
    if (typeof raw !== 'string') continue;
    const redacted = redactQueryParamsInString(raw, key);
    if (redacted !== raw) {
      next[key] = redacted;
      changed = true;
    }
  }
  return changed ? next : null;
}

function redactQueryParamsInString(value, key) {
  try {
    if (key === 'url.full') {
      const u = new URL(value);
      let changed = false;
      for (const k of [...u.searchParams.keys()]) {
        if (REDACT_QUERY_PARAM.test(k)) {
          u.searchParams.set(k, '[REDACTED]');
          changed = true;
        }
      }
      return changed ? u.toString() : value;
    }
    // key === 'url.query': use URLSearchParams directly (no full URL form).
    const params = new URLSearchParams(value);
    let changed = false;
    for (const k of [...params.keys()]) {
      if (REDACT_QUERY_PARAM.test(k)) {
        params.set(k, '[REDACTED]');
        changed = true;
      }
    }
    return changed ? params.toString() : value;
  } catch { return value; }
}

function wrapSpanWithReplacements(span, replacements) {
  // Filter to keys that actually have a replacement value (attributes may be null/undefined
  // when no URL redaction is needed — in that case we only swap resource).
  const keys = Object.keys(replacements).filter((k) => replacements[k] !== undefined && replacements[k] !== null);
  if (keys.length === 0) return span;

  // Path 1: try in-place defineProperty for all replacement keys. If every key takes effect,
  // return the original span (mutated in place).
  let allInPlace = true;
  for (const key of keys) {
    try {
      Object.defineProperty(span, key, { value: replacements[key], configurable: true });
      // Read-back assertion: defineProperty can silently no-op on a non-configurable property
      // defined via a getter on the prototype.
      if (span[key] !== replacements[key]) {
        allInPlace = false;
        break;
      }
    } catch {
      allInPlace = false;
      break;
    }
  }
  if (allInPlace) return span;

  // Path 2: wrapper-object — Object.create + Object.assign + property assignment. Handles
  // Object.freeze() spans because we produce a fresh non-frozen wrapper from the source.
  try {
    const wrapper = Object.create(Object.getPrototypeOf(span));
    Object.assign(wrapper, span);
    for (const key of keys) wrapper[key] = replacements[key];
    // Verify the writes took (Object.assign on a frozen source still copies enumerables;
    // direct assignment on the wrapper is fine because the wrapper is fresh).
    let wrapperOk = true;
    for (const key of keys) {
      if (wrapper[key] !== replacements[key]) { wrapperOk = false; break; }
    }
    if (wrapperOk) return wrapper;
  } catch { /* fall through to Proxy */ }

  // Path 3: Proxy last resort. Forwards every key except the replacement set.
  return new Proxy(span, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(replacements, prop) &&
          replacements[prop] !== undefined && replacements[prop] !== null) {
        return replacements[prop];
      }
      return target[prop];
    },
  });
}
