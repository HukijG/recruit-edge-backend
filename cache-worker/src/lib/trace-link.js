import { trace } from '@opentelemetry/api';

const TRACE_PARAM = '_otel_trace';

export function makeAsyncCallbackUrl(baseUrl, extraParams = {}) {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, String(v));
  }
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext()?.traceId;
  if (traceId) url.searchParams.set(TRACE_PARAM, traceId);
  return url.toString();
}

export function readInboundTraceLink(request) {
  const traceId = new URL(request.url).searchParams.get(TRACE_PARAM);
  if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  return {
    traceId,
    spanId: '0'.repeat(16),
    traceFlags: 1,
  };
}
