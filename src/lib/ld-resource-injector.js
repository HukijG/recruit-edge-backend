import { resourceFromAttributes } from '@opentelemetry/resources';

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
      try {
        Object.defineProperty(span, 'resource', { value: cachedResource, configurable: true });
        // Read-back assertion: defineProperty can silently no-op on a non-configurable property
        // that's defined via a getter on the prototype. Verify it actually took effect; fall
        // back to Proxy wrapping if not.
        if (span.resource === cachedResource) return span;
      } catch { /* throws → fall through to Proxy */ }
      // Proxy invariants forbid returning a substitute value for a non-configurable,
      // non-writable property on the target (e.g. a frozen span). Detect that case and
      // fall back to a copy-wrapper that preserves the original prototype chain.
      const desc = Object.getOwnPropertyDescriptor(span, 'resource');
      if (desc && !desc.configurable && !desc.writable) {
        const wrapper = Object.create(Object.getPrototypeOf(span));
        Object.assign(wrapper, span);
        wrapper.resource = cachedResource;
        return wrapper;
      }
      return new Proxy(span, {
        get(target, prop) {
          return prop === 'resource' ? cachedResource : target[prop];
        },
      });
    });
  };
}
