import { trace } from '@opentelemetry/api';

const TRACE_PARAM = '_otel_trace';

export function makeAsyncCallbackUrl(baseUrl, extraParams = {}, options = {}) {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, String(v));
  }
  // `options.traceId` lets a multi-hop async chain (e.g. the Apollo waterfall re-run
  // loop) keep linking to the ORIGINAL flow's trace instead of each hop's own trace.
  // Falls back to the active span's trace for the normal single-hop kickoff.
  const traceId = options.traceId || trace.getActiveSpan()?.spanContext()?.traceId;
  if (traceId && /^[0-9a-f]{32}$/.test(traceId)) url.searchParams.set(TRACE_PARAM, traceId);
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
