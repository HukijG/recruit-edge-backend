import { SpanStatusCode } from '@opentelemetry/api';

/**
 * Wraps a Workflow `step` API so each step.do / step.waitForEvent invocation
 * emits its own child span on the supplied tracer. The tracer is passed in
 * explicitly so Workflow callers can hand in their LOCAL Workflow tracer —
 * see `lib/bootstrap-otel.js` for why Workflow contexts need a local
 * TracerProvider instead of relying on the @opentelemetry/api global.
 *
 * @param {object} step       - Real Workflow step API (or test shim)
 * @param {Tracer} tracer     - OTel Tracer instance — emit child spans on this
 * @param {string} instanceId - Workflow instance id (for span attributes)
 */
export function instrumentedStep(step, tracer, instanceId) {
  return {
    do(name, configOrFn, maybeFn) {
      const hasConfig = typeof configOrFn !== 'function';
      const fn = hasConfig ? maybeFn : configOrFn;
      const config = hasConfig ? configOrFn : undefined;

      // Per-attempt span: each retry re-enters this closure and creates a fresh
      // child span, so retries are visible separately under the outer Workflow span.
      // The wrapper is pure observability; step idempotency is preserved.
      const wrappedFn = async () => {
        return await tracer.startActiveSpan(
          `step.do:${name}`,
          { attributes: { 'step.name': name, 'workflow.id': instanceId } },
          async (span) => {
            try {
              return await fn();
            } catch (err) {
              span.recordException(err);
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
              throw err;
            } finally {
              span.end();
            }
          }
        );
      };

      return hasConfig ? step.do(name, config, wrappedFn) : step.do(name, wrappedFn);
    },
    sleep(...args) { return step.sleep(...args); },
    sleepUntil(...args) { return step.sleepUntil(...args); },
    async waitForEvent(name, options) {
      return await tracer.startActiveSpan(
        `step.waitForEvent:${name}`,
        {
          attributes: {
            'step.name': name,
            'workflow.id': instanceId,
            'event.type': options?.type ?? '',
          },
        },
        async (span) => {
          try {
            return await step.waitForEvent(name, options);
          } catch (err) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
            throw err;
          } finally {
            span.end();
          }
        }
      );
    },
  };
}
