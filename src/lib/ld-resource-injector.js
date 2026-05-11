import { resourceFromAttributes } from '@opentelemetry/resources';

const REDACT_QUERY_PARAM = /secret|token|api[_-]?key|apikey/i;
const URL_ATTR_KEYS = ['url.full', 'url.query'];

export function makeLdResourceInjector(sdkKey) {
  if (!sdkKey || typeof sdkKey !== 'string') {
    throw new Error('makeLdResourceInjector: LD_SDK_KEY is required (got: ' + typeof sdkKey + ')');
  }
  let cachedResource = null;

  return function postProcessor(spans) {
    if (!Array.isArray(spans) || spans.length === 0) return spans;

    if (!cachedResource) {
      const base = spans[0].resource;
      const ldExtra = resourceFromAttributes({ 'launchdarkly.project_id': sdkKey });
      cachedResource = base && typeof base.merge === 'function' ? base.merge(ldExtra) : ldExtra;
    }

    return spans.map((span) => {
      const redactedAttrs = computeRedactedAttributes(span.attributes);
      return wrapSpanWithReplacements(span, {
        resource: cachedResource,
        attributes: redactedAttrs,
      });
    });
  };
}

function computeRedactedAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  let changed = false;
  const next = { ...attrs };
  for (const key of URL_ATTR_KEYS) {
    const raw = attrs[key];
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
