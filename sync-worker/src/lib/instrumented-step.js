import { trace, SpanStatusCode } from '@opentelemetry/api';

export function instrumentedStep(step, tracerName, instanceId) {
  const tracer = trace.getTracer(tracerName);
  return {
    do(name, configOrFn, maybeFn) {
      const hasConfig = typeof configOrFn !== 'function';
      const fn = hasConfig ? maybeFn : configOrFn;
      const config = hasConfig ? configOrFn : undefined;

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
