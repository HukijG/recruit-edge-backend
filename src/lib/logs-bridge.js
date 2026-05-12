import { env } from 'cloudflare:workers';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

const DEFAULT_LD_OTLP_LOGS_URL = 'https://otel.observability.app.launchdarkly.com/v1/logs';

let installed = false;
let _provider = null;

export function installLogsBridge(serviceName) {
  // Emergency kill switch — wholesale disables the console.* wrap so no OTel log records are emitted.
  // Independent of LD_SDK_KEY (which controls whether export is even possible).
  if (env && env.OTEL_DISABLED === '1') return;
  if (installed) return;
  installed = true;

  if (!env.LD_SDK_KEY) {
    (console.error || console.log)({ source: 'logs-bridge', message: 'LD_SDK_KEY missing; OTel log export disabled' });
    return;
  }

  const resource = resourceFromAttributes({
    'service.name': serviceName || 'unknown-service',
    'launchdarkly.project_id': env.LD_SDK_KEY,
    'cloud.provider': 'cloudflare',
    'cloud.platform': 'cloudflare.workers',
  });

  const exporter = new OTLPLogExporter({
    url: env.LD_OTLP_LOGS_URL || DEFAULT_LD_OTLP_LOGS_URL,
    headers: {},
  });

  const provider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(exporter, {
        scheduledDelayMillis: 1000,
        maxExportBatchSize: 512,
      }),
    ],
  });
  logs.setGlobalLoggerProvider(provider);
  _provider = provider;

  const logger = logs.getLogger('worker-console', '1.0.0');

  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args) => { originalLog(...args); emit(logger, SeverityNumber.INFO, 'INFO', args); };
  console.info = (...args) => { originalInfo(...args); emit(logger, SeverityNumber.INFO, 'INFO', args); };
  console.warn = (...args) => { originalWarn(...args); emit(logger, SeverityNumber.WARN, 'WARN', args); };
  console.error = (...args) => { originalError(...args); emit(logger, SeverityNumber.ERROR, 'ERROR', args); };
}

function emit(logger, severityNumber, severityText, args) {
  try {
    if (args.length === 1 && args[0] instanceof Error) {
      logger.emit({
        severityNumber,
        severityText,
        body: args[0].message,
        attributes: {
          'exception.type': args[0].name,
          'exception.stacktrace': args[0].stack || '',
        },
      });
      return;
    }
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      const obj = args[0];
      const { message, source, ...rest } = obj;
      let bodyText;
      try {
        bodyText = typeof message === 'string'
          ? message
          : (source ? `[${source}]` : safeStringify(obj).slice(0, 4096));
      } catch {
        bodyText = '<unserializable>';
      }
      const attributes = source ? { source, ...rest } : rest;
      logger.emit({ severityNumber, severityText, body: bodyText, attributes });
      return;
    }
    const body = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ').slice(0, 8192);
    logger.emit({ severityNumber, severityText, body });
  } catch { /* never throw on telemetry */ }
}

function safeStringify(o) {
  try { return JSON.stringify(o); }
  catch { return String(o); }
}

/**
 * Force-flush the queued OTel log records through the LoggerProvider.
 * Returns a Promise that resolves once all batched records have been
 * exported (or rejected). Safe to call when LD_SDK_KEY is missing or
 * OTEL_DISABLED=1 — returns a resolved Promise (no-op).
 */
export function flushLogs() {
  if (!_provider) return Promise.resolve();
  try {
    const p = _provider.forceFlush();
    return p && typeof p.then === 'function' ? p : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/**
 * Wrap an ExportedHandler so that after each fetch / scheduled / queue
 * invocation, all handler-side ctx.waitUntil promises are awaited and
 * then the OTel LoggerProvider is force-flushed. Without this wrap, the
 * BatchLogRecordProcessor's 1s scheduled flush will not fire before fast
 * handlers terminate, and queued logs are dropped.
 *
 * Mirrors the @microlabs trace-flush pattern (vendor sdk.ts:158, exportSpans
 * awaits tracker.wait() before forceFlush). The two flush paths run as
 * separate ctx.waitUntil promises and resolve independently.
 *
 * Order matters at the export site: wrap the user handler with
 * withLogsFlush FIRST, then wrap that with @microlabs instrument(). The
 * instrument() outer wrap proxies ctx itself; our proxy nests inside.
 */
export function withLogsFlush(handler) {
  const wrapped = {};
  if (typeof handler.fetch === 'function') {
    const original = handler.fetch;
    wrapped.fetch = async function (request, env, ctx) {
      const tracked = [];
      const proxyCtx = makeTrackingCtxProxy(ctx, tracked);
      try {
        return await original.call(handler, request, env, proxyCtx);
      } finally {
        // Real CF runtime always provides ctx.waitUntil; tests sometimes pass {}.
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil((async () => {
            try { await Promise.allSettled(tracked); } catch { /* swallow */ }
            try { await flushLogs(); } catch { /* swallow */ }
          })());
        }
      }
    };
  }
  if (typeof handler.scheduled === 'function') {
    const original = handler.scheduled;
    wrapped.scheduled = async function (event, env, ctx) {
      const tracked = [];
      const proxyCtx = makeTrackingCtxProxy(ctx, tracked);
      try {
        return await original.call(handler, event, env, proxyCtx);
      } finally {
        // Real CF runtime always provides ctx.waitUntil; tests sometimes pass {}.
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil((async () => {
            try { await Promise.allSettled(tracked); } catch { /* swallow */ }
            try { await flushLogs(); } catch { /* swallow */ }
          })());
        }
      }
    };
  }
  if (typeof handler.queue === 'function') {
    const original = handler.queue;
    wrapped.queue = async function (batch, env, ctx) {
      const tracked = [];
      const proxyCtx = makeTrackingCtxProxy(ctx, tracked);
      try {
        return await original.call(handler, batch, env, proxyCtx);
      } finally {
        // Real CF runtime always provides ctx.waitUntil; tests sometimes pass {}.
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil((async () => {
            try { await Promise.allSettled(tracked); } catch { /* swallow */ }
            try { await flushLogs(); } catch { /* swallow */ }
          })());
        }
      }
    };
  }
  if (typeof handler.email === 'function') {
    wrapped.email = handler.email;
  }
  return wrapped;
}

function makeTrackingCtxProxy(ctx, tracked) {
  return {
    waitUntil(promise) {
      tracked.push(Promise.resolve(promise).catch(() => {}));
      if (ctx && typeof ctx.waitUntil === 'function') {
        return ctx.waitUntil(promise);
      }
      return undefined;
    },
    passThroughOnException: ctx && typeof ctx.passThroughOnException === 'function'
      ? ctx.passThroughOnException.bind(ctx)
      : undefined,
  };
}
