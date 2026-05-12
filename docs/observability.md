# Observability — LaunchDarkly via @microlabs/otel-cf-workers

Live reference for the observability pipeline. Read this when adding a new worker, entry handler, async-kickoff pattern, AI call site, Workflow, or when an alert fires.

## Overview

Every Cloudflare worker in this repo emits OpenTelemetry traces and logs to LaunchDarkly Observability, with a separate hourly metrics pump for billing-precision numbers. Two parallel pipelines run inside each worker: a trace SDK provided by `@microlabs/otel-cf-workers` (auto-instruments fetch + KV / D1 / Durable Objects / Queues / Cache bindings) and a logs SDK from `@opentelemetry/sdk-logs` (with a `console.*` bridge so existing structured-log calls flow into LD as log records, correlated to the active trace). Cloudflare's native observability stays enabled at `head_sampling_rate: 0.1` on every worker as an always-on no-cost fallback dashboard — LD is primary, CF native is the safety net. A fourth `rf-cf-metrics-poller` worker runs on an hourly cron and pushes three CF GraphQL Analytics metrics (D1 storage bytes, KV stored bytes, Workers AI neurons) to LD's `/v1/metrics` endpoint as OTel metric records.

## Architecture diagram

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  LaunchDarkly Observability (project rf-dialpad-sync)                              │
│  Host: otel.observability.app.launchdarkly.com:443                                 │
│  Auth: launchdarkly.project_id=<LD_SDK_KEY> as resource attribute                  │
│  Endpoints: /v1/traces   /v1/logs   /v1/metrics                                    │
└──┬──────────────────┬──────────────────┬─────────────────────────┬────────────────┘
   │ /v1/traces       │ /v1/traces       │ /v1/traces              │ /v1/metrics
   │ /v1/logs         │ /v1/logs         │ /v1/logs                │ /v1/traces, /v1/logs
   │                  │                  │                         │
┌──┴──────────────┐ ┌─┴────────────────┐ ┌┴───────────────────┐ ┌─┴──────────────────┐
│  main worker     │ │  cache-worker     │ │  mcp-remote        │ │  metrics-poller    │
│  rf-dialpad-     │ │  rf-mcp-cache-   │ │  rf-mcp-remote     │ │  rf-cf-metrics-    │
│  sync-dev        │ │  sync            │ │                    │ │  poller            │
│                  │ │                  │ │                    │ │                    │
│ installBody-     │ │ installBody-     │ │ installBody-       │ │ installBody-       │
│  Capture()       │ │  Capture()       │ │  Capture()         │ │  Capture()         │
│ installLogs-     │ │ installLogs-     │ │ installLogs-       │ │ installLogs-       │
│  Bridge('main')  │ │  Bridge('sync')  │ │  Bridge('mcp')     │ │  Bridge('poller')  │
│ instrument(h,    │ │ bootstrapOtelFor-│ │ instrument(h,      │ │ instrument(h,      │
│  resolveOtelCfg) │ │  Workflows()     │ │  resolveOtelCfg)   │ │  resolveOtelCfg)   │
│                  │ │ instrument(h,    │ │                    │ │                    │
│                  │ │  resolveOtelCfg) │ │                    │ │  cron: hourly      │
│                  │ │                  │ │                    │ │  GraphQL → OTLP    │
└─────────▲────────┘ └─▲────────────────┘ └──┬─────────────────┘ └─▲──────────────────┘
          │            │                     │ service binding     │ env.CF_API_TOKEN
          │            │                     │ (trace context      │ env.CF_ACCOUNT_ID
          │            │                     │ propagates via      │                  
          │            │                     │ traceparent header) │ Cloudflare       
          │            │                     ▼                     │ GraphQL          
          │            │                  ┌──┐                     │ Analytics API    
          │            │                  └──┘                     │                  
          │            │                  (downstream call lands   │                  
          │            │                  back in main worker —    │                  
          │            │                  upstream span links via  │                  
          │            │                  acceptRemote: true)      │                  
          │            │                                           │                  
          └────────────┴───────────────────────────────────────────┘                  
                       (all four workers also keep CF native observability            
                        enabled at head_sampling_rate: 0.1 as fallback)               
```

Trace context propagates automatically across service-binding hops because the upstream worker's outbound fetch (after `@microlabs`' `instrument()` wraps it) emits a `traceparent` header, and the downstream's `acceptRemote: true` parent-based sampler honors it. No manual stitching is needed for service-binding routes. For async webhook-callback patterns where the round-trip isn't synchronous (e.g., Apollo enrichment), use `makeAsyncCallbackUrl` + `readInboundTraceLink` to attach an explicit `addLink({ context })` on the callback span (see § Adding async kickoff / callback below).

## PII trade-off

This is a load-bearing design choice — read it before changing any body-capture, redaction, or kill-switch behavior.

**Body capture for RF, Dialpad, Apollo, and Krisp request and response bodies is deliberate, not an oversight.** Cloudflare's native observability swallows bodies — by design, it's a runtime-error and request-metadata view. That makes debugging "expected behavior, unexpected outcome" failures essentially impossible: "why didn't this candidate sync after the RF webhook?", "why did this Dialpad number fail to send SMS?", "why did the cold-call transcript fail to format in RF?" all hinge on inspecting the real request and response payloads at the boundary. Without bodies, the entire reason to spend the engineering on a richer observability stack collapses.

The consequence: **LaunchDarkly is the PII custodian** for candidate names, emails, phone numbers, LinkedIn URLs, call transcripts, interview notes, and Apollo enrichment payloads (which include scored candidate profiles). This is accepted because:

1. **The operator already has full CRM access** to the same data via Recruiterflow's UI. LD's view doesn't grant any new read access — it surfaces what's already accessible inside the trust boundary.
2. **The alternative defeats the implementation.** Logging non-PII-only would mean shipping shapes, statuses, and counts — useful for traffic monitoring, useless for diagnosing wire-level integration bugs. We considered the no-body path; it doesn't pay rent.
3. **LD's auth boundary mirrors the trust posture for CF / RF / Dialpad / Apollo.** Each of those vendors stores PII under an auth-gated console; LD's SDK key + UI access controls play the same role. Compromising LD is equivalent in blast radius to compromising any one of those existing vendors.

**Acceptable defense-in-depth hygiene** is wired up and tested:

- **Auth header redaction is automatic.** `Authorization` and `Cookie` headers are never captured into span attributes. The header-allowlist code is in `src/lib/body-capture.js` (plus byte-identical copies in `cache-worker/`, `mcp-remote/`, `metrics-poller/`).
- **Body-field redaction.** Keys matching the regex `password|secret|token|api_key|apikey|client_secret|private_key` are replaced with `[REDACTED]` in captured JSON request and response bodies. Nested objects are walked recursively.
- **URL query-parameter redaction.** Parameters matching the regex `secret|token|api[_-]?key|apikey|email|linkedin|phone|attendee_email|attendee_phone` get their value replaced with `[REDACTED]` in both `url.full` and `url.query` span attributes. This is a widened set added in the post-merge fix pass — it covers calendar-webhook query strings as well as legacy `?email=…` style RF callback URLs.
- **Two runtime kill switches**, both via Cloudflare secrets, no redeploy required:
  - `LOG_NO_BODY=1` — disables body content capture only. Spans + log records still ship to LD with the auto-instrumented attributes (URLs, status codes, durations), but without `http.request.body` / `http.response.body` attributes. Use this for incident response on a specific flow that's leaking unexpected sensitive data.
  - `OTEL_DISABLED=1` — disables both the body-capture fetch wrapper and the logs-bridge `console.*` wrap wholesale. The worker continues to run; observability emission is short-circuited. This is the emergency lever: use it if LD itself is misbehaving (e.g., storing data it shouldn't even by our trust posture, or if you need to cut emission while filing a deletion request).

**If LD ever stores something it shouldn't**, use `OTEL_DISABLED=1` first to stop the bleeding, then file an LD data-deletion request through their support path. The runtime wrappers do not retroactively scrub already-emitted spans.

## Per-worker setup pattern

Every worker's entry module installs in this exact order at module top, **before** any handler logic runs:

1. `installBodyCapture()` — patches `globalThis.fetch` with a wrapper that reads the request body (handling both raw-init bodies and `fetch(new Request(...))` shapes), reads the response body in a streamed manner with a byte budget, redacts header / body / URL secrets per the rules above, and stamps `http.request.body` / `http.response.body` attributes onto the active span.
2. `installLogsBridge('<service-name>')` — registers the global OTel `LoggerProvider`, points the `BatchLogRecordProcessor` at LD's `/v1/logs`, and patches `console.log/info/warn/error` to also emit OTel log records correlated to the active trace (`trace_id` + `span_id` are picked up from the active span context if any). The service name in this call is the resource attribute identifying the worker — keep it stable.
3. **Wrap with `withLogsFlush(handler)` then conditional `instrument()`.** The handler object is wrapped with `withLogsFlush` from `./lib/logs-bridge.js` BEFORE the `@microlabs/instrument()` outer wrap:
   ```js
   const wrappedHandler = withLogsFlush(handler);
   export default LD_SDK_KEY ? instrument(wrappedHandler, resolveOtelConfig) : wrappedHandler;
   ```
   `withLogsFlush` proxies `ctx` to track inner `ctx.waitUntil` promises and, in `finally`, registers a `ctx.waitUntil` that awaits them and calls `flushLogs()`. Without it, `BatchLogRecordProcessor`'s 1000ms scheduled flush doesn't fire before fast handlers (<1s) terminate and logs are dropped. The `instrument()` conditional gate on `LD_SDK_KEY` keeps Vitest fetch-mock isolation clean (`instrument()` swaps `globalThis.fetch` for a proxy that captures fetch spans via `ctx.waitUntil`).

**Ordering invariant.** Body capture must wrap the real `globalThis.fetch` **before** `@microlabs`' `instrument()` proxy wraps it. Otherwise `installBodyCapture()` would wrap the @microlabs proxy, and the body-stamping path would run inside the wrong span scope. The "install body capture → install logs bridge → wrap with `withLogsFlush` → conditional `instrument`" sequence at the top of every worker's entry module enforces this. See `vendor/otel-cf-workers/VENDOR.md` for the @microlabs internal details.

**Cache worker addition.** Cloudflare Workflow runs do not go through the same `instrument()` wrap as fetch / scheduled handlers — their `run()` lifecycle is invoked by the platform outside the fetch entry. The cache-worker exposes a **Workflow-local TracerProvider** via `getWorkflowTracer(serviceName, tracerName)` from `cache-worker/src/lib/bootstrap-otel.js`. Workflow.run() bodies call `getWorkflowTracer(...)` to get a tracer backed by a local `BasicTracerProvider` + `OTLPTraceExporter` and `await flushWorkflowSpans()` in their `finally` block to force-flush before the run context tears down. `bootstrap-otel` intentionally does NOT call `trace.setGlobalTracerProvider`; that would clobber `@microlabs`'s `WorkerTracerProvider` registration for fetch/scheduled handlers (the `@opentelemetry/api` singleton rejects duplicate registrations — first writer wins). The test asserts `setGlobalTracerProvider` is never called from `bootstrap-otel` as a load-bearing invariant.

**File pointers per worker:**
- main: `src/index.js` (top of file)
- sync: `cache-worker/src/index.js` (top of file)
- mcp: `mcp-remote/src/index.ts` (top of file)
- poller: `metrics-poller/src/index.ts` (top of file)

## Helpers reference

Every worker has a byte-identical `lib/` directory with the five core helpers (plus per-worker additions). Edit one copy and copy across; the closed-set drift tests guard against silent divergence.

- **`flow-names`** — `src/lib/flow-names.js` + `cache-worker/src/lib/flow-names.js` + `mcp-remote/src/lib/flow-names.ts` + `metrics-poller/src/lib/flow-names.ts`. Closed-set frozen enum of every entry-handler label used by the worker. Usage: `import { FLOWS } from './lib/flow-names'; trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.MY_HANDLER);`. Each worker has a sibling `test/lib/flow-names.spec.{js,ts}` that asserts the set is closed + frozen — any silent drift fails CI.

- **`otel-config` (`resolveOtelConfig`)** — `src/lib/otel-config.js` + 3 sibling copies. Assembles the @microlabs `TraceConfig`: exporter URL (`env.LD_OTLP_TRACES_URL` || the LD default), service name, `launchdarkly.project_id` resource attribute, head sampler ratio 1.0 with `acceptRemote: true`, tail sampler `[isHeadSampled, isRootErrorSpan]`, and the `postProcessor` that injects the LD resource attribute and PII URL redaction. Throws if `env.LD_SDK_KEY` is missing.

- **`ld-resource-injector`** — `src/lib/ld-resource-injector.js` + 3 sibling copies. Implements the `postProcessor` that runs on every exported span. Responsibilities, in order: (1) inject the `launchdarkly.project_id` resource attribute; (2) prune `NOISE_KEYS` from both resource attributes (set once at SDK init via `@microlabs`'s `createResource`) and per-span attributes — the dropped set covers `cloud.{provider,platform,region}`, `faas.{max_memory,invocation_id,trigger}`, `telemetry.sdk.{language,name,version,build.node_version}`, `net.{asn,colo,country,tcp_rtt,tls_cipher,tls_version}`, `network.protocol.{name,version}`, `http.{accepts,accept_encoding}`, `url.{domain,scheme}`, `feature_flag.set.id` (intentionally KEPT for debugging: `faas.coldstart`, `server.address`, `user_agent.original`, `service.name`, all `flow.name`, `rf.event_type`, `dialpad.event_type`, `consultant.email`, `http.url.*`, `http.request.*`, `http.response.*`, `ai.*`, `workflow.id`, `step.name`, all `launchdarkly.*`, and core span fields); (3) override `span.name` with the `flow.name` attribute value when present, so LD trace-tree labels read as flow names (`WebhookDialpadExtensionCall`, `CronTailSync`, `MCP/Post`, `CronCandidatesTick`, etc.) instead of `@microlabs` defaults (`fetchHandler POST`, `scheduledHandler */15 * * * *`, `cache.cron.tick`); (4) redact `secret|token|api[_-]?key|apikey` query params in `url.full` / `url.query` span attributes. `flow.name` remains in attributes after rename so filter/groupBy queries continue to work. Wired in via `resolveOtelConfig`. Has its own vendor-patch guard test at `test/lib/otel-postprocessor.spec.js` plus per-worker spec tests covering the noise-prune and flow.name-promotion behaviors.

- **`body-capture`** — `src/lib/body-capture.js` + 3 sibling copies. Patches `globalThis.fetch` to stamp `http.request.body` and `http.response.body` attributes on the active fetch span. Reads outbound `fetch(new Request(...))` bodies via `input.clone().text()` (the case the @microlabs proxy hits when it invokes the inner wrapped fetch as `fetch(Request, undefined)`). Streams response bodies via `response.body.getReader()` with a `MAX_BODY_BYTES` budget, fire-and-forgets `reader.cancel()` on overflow (awaiting deadlocks tee branches in Node), and appends `…[truncated, original >${MAX_BODY_BYTES} bytes]`. Honors `LOG_NO_BODY=1` (skip body content) and `OTEL_DISABLED=1` (skip the entire wrap).

- **`logs-bridge`** — `src/lib/logs-bridge.js` + 3 sibling copies. Registers the global `LoggerProvider` (with the same `launchdarkly.project_id` resource attribute), constructs an `OTLPLogExporter` pointed at LD's `/v1/logs`, and patches `console.log/info/warn/error` to also emit OTel log records via the global Logger. The existing `console.log({ source, message, ...fields })` shape lifts cleanly: `body=message`, `attributes={source, ...fields}`, severity mapped from method. Honors `OTEL_DISABLED=1` (skip provider registration and console wrap). **Also exports `flushLogs()` and `withLogsFlush(handler)`** — `BatchLogRecordProcessor`'s 1000ms scheduled flush won't fire before fast handlers (<1s) terminate, so each worker entry wraps `withLogsFlush(handler)` INSIDE the `@microlabs/instrument()` outer wrap. The wrapper proxies `ctx` to track inner `ctx.waitUntil` promises, then in `finally` registers a `ctx.waitUntil` that awaits the tracked promises and calls `flushLogs()`. Workflow contexts (no ctx) call `await flushLogs()` in `finally` alongside `await flushWorkflowSpans()`.

- **`ai-instrument` (`runAI`)** — `src/lib/ai-instrument.js` (main worker only). `runAI(env, modelName, input, options?)` wraps `env.AI.run` in a span named `ai.run` with attributes `ai.model`, `ai.input` (truncated JSON), `ai.response` (truncated JSON), `ai.tokens_input`, `ai.tokens_output`, plus duration. Direct `env.AI.run` is banned per the project hard rule. Throws on streaming-mode calls — there are no current streaming sites, and a streaming path would need a different span-end strategy; the throw is a loud signal that someone introducing streaming has to instrument deliberately.

- **`trace-link`** — `src/lib/trace-link.js` (main + sync). `makeAsyncCallbackUrl(baseUrl, extraParams)` (kickoff side) appends an `_otel_trace` query param containing the active trace's `traceparent`-shaped fingerprint. `readInboundTraceLink(request)` (receiving side) parses that param back into a `SpanContext` you can attach via `addLink({ context })` on the receiving span. Used for async webhook-callback patterns — the canonical site is Apollo enrichment kickoff + completion webhook.

- **`instrumented-step`** — `cache-worker/src/lib/instrumented-step.js` (cache worker only). `instrumentedStep(step, tracer, instanceId)` (note: takes a Tracer OBJECT, not a tracerName string — the Workflow-local provider is created by `bootstrap-otel`'s `getWorkflowTracer`) returns a wrapped `step` object whose `do(...)` invocations are surrounded by a per-attempt span. The wrapper is pure observability — it preserves `step.do` idempotency semantics by re-entering the closure on retries, which gets each attempt its own child span. Each Workflow class uses this throughout its `run()` body.

- **`bootstrap-otel`** — `cache-worker/src/lib/bootstrap-otel.js` (cache worker only). Exposes `getWorkflowTracer(serviceName, tracerName)` (returns a tracer from a local lazily-initialized `BasicTracerProvider` + `OTLPTraceExporter`) and `flushWorkflowSpans()` (calls `provider.forceFlush()`). Workflow `run()` bodies call `getWorkflowTracer(...)` and `await flushWorkflowSpans()` in `finally`. Does NOT call `trace.setGlobalTracerProvider` — that would clobber `@microlabs`'s `WorkerTracerProvider` for fetch/scheduled contexts (OTel API rejects duplicate global registration). `instrumented-step` accepts the tracer as a parameter (not a tracerName string) so step spans share the same local provider.

## Adding a new entry handler

1. Add a constant to the worker's `lib/flow-names.{js,ts}` describing the handler (`FLOWS.WEBHOOK_NEW_THING`).
2. Update the closed-set test in `test/lib/flow-names.spec.{js,ts}` (the test fails CI if you skip this).
3. At the **top of the handler body**, before any branching logic: `trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_NEW_THING);`
4. If the handler is webhook-shaped (RF, Dialpad, etc.), also set the event-type attribute **after parsing the payload**:
   - RF: `trace.getActiveSpan()?.setAttribute('rf.event_type', eventType || 'unknown');`
   - Dialpad webhooks (general): `setAttribute('dialpad.event_type', payload.event || 'unknown');`
   - Dialpad call webhooks: `setAttribute('dialpad.event_type', payload.state || 'unknown');` (call payloads use `state`, not `event`)

The event-type attribute drives the per-event-type panels in Dashboard 4 (webhook + integration health).

## Adding async kickoff / callback

Use this when the call-site fires a request that completes via a separate inbound webhook later (Apollo enrichment is the canonical case).

**Kickoff site** (the worker that initiates the work):

```js
import { makeAsyncCallbackUrl } from './lib/trace-link';

// inside the active span:
const callbackUrl = makeAsyncCallbackUrl(
  'https://your-worker.example/webhook/inbound',
  { jobId: '123' }
);
// then pass callbackUrl to the external service as its callback target
```

**Receiving site** (the inbound webhook handler):

```js
import { trace } from '@opentelemetry/api';
import { readInboundTraceLink } from './lib/trace-link';

const link = readInboundTraceLink(request);
if (link) trace.getActiveSpan()?.addLink({ context: link });
// proceed with handler logic
```

The link surfaces in LD as a connected trace edge (LD's UI rendering of `addLink` may or may not surface as a UI affordance — at minimum the link attribute persists at the OTLP layer and is queryable via SQL).

## Adding a new Workers AI call site

Use `runAI(env, modelName, input, options?)` from `src/lib/ai-instrument.js`. Direct `env.AI.run` is **banned** project-wide per the hard rule in `CLAUDE.md`. The helper wraps the call in an `ai.run` span with model name, input shape, token usage, duration, and (PII-aware) request/response body attributes.

## Adding a new Workflow

1. Get a Workflow-local tracer: `const tracer = getWorkflowTracer('rf-mcp-cache-sync', 'rf-mcp-cache-sync');` (imported from `./lib/bootstrap-otel.js`). Do NOT use `trace.getTracer(...)` from `@opentelemetry/api` — that resolves to the global provider, which Workflow contexts don't have.
2. Wrap the `run(event, step)` body in `tracer.startActiveSpan('Workflow<Name>', { attributes: { 'flow.name': FLOWS.WORKFLOW_X, 'workflow.id': event.instanceId } }, async (span) => { ... });`.
3. Wrap the `step` parameter via `instrumentedStep(step, tracer, event.instanceId)` — note the tracer object is passed directly (not a tracerName string) — and use the wrapped version throughout the body so retries become individually visible.
4. In the `finally` block (after `span.end()`), `await flushWorkflowSpans();` then `await flushLogs();` (the latter imported from `./lib/logs-bridge.js`). Without these the local providers' batch flushes won't fire before the run context tears down.
5. Add the corresponding `FLOWS.WORKFLOW_X` constant to `cache-worker/src/lib/flow-names.js` and update its closed-set test.

## Sampling, kill switches, cost

**Head sampling.** Path-conditional via `PathRatioSampler` wrapped in `ParentBasedSampler` (see `src/lib/otel-config.js`). High-volume polling routes drop at root-span time so child spans are never created; everything else stays at ratio `1.0`. Current rules in `PATH_SAMPLING_RULES`:

| Path | Ratio | Why |
|---|---|---|
| `/extension-call-status` | `0.1` | Extension polls every ~500ms during an active Dialpad call. A 5-min call ≈ 600 polls × 3 spans + log records = 2000 telemetry records that would drown out everything else in LD. 10% keeps a sanity signal. |
| (default) | `1.0` | Everything else — 100% to LD. |

Cross-worker traces honour upstream head decisions via `ParentBasedSampler` (service-binding inbound). The tail sampler `[isHeadSampled, isRootErrorSpan]` retains all head-sampled traces and additionally retains error-root spans regardless of head decision — error spans never get dropped. **Add new high-volume routes to `PATH_SAMPLING_RULES` rather than per-call overrides.**

**CF native observability.** Set at `head_sampling_rate: 0.1` (10%) in every worker's `wrangler.*.jsonc`. Acts as an always-on no-cost dashboard fallback for cases where LD is unreachable or you want to cross-check via the Cloudflare dashboard.

**Cost at current load.** With ~5 internal users, traffic estimates: ~250 traces/day → ~5k spans/day → ~150k spans/mo. LD Observability free tier is 25M spans/mo, so we're at ~0.6% of the ceiling — cost-comfortable for ~10–15× growth before considering plan changes. Alert 4 fires if projected ingest crosses the free-tier ceiling (with a 5-day lead).

**Kill switches.**

| Switch | Effect | When to use |
|---|---|---|
| `LOG_NO_BODY=1` | Disable body content capture only (spans + log records still ship without `http.request.body` / `http.response.body`) | Body-capture leaking unexpected sensitive data through a specific flow |
| `OTEL_DISABLED=1` | Disable both fetch wrapper and console bridge wholesale (no traces, no logs, no body content) | Emergency lever — LD misbehaving, or PII not even the operator should see has leaked |
| `AI_LOG_BODY=1` | Opt-IN switch for AI request/response body capture in `runAI`. Currently AI body capture is ON by default per the PII trade-off; this flag exists so it can be flipped without a redeploy if needed | Future use only — does nothing today |

All three are read at request time from `env.*`. Set / unset via `wrangler secret put` or `wrangler secret delete`; changes propagate within seconds, no redeploy.

**LD vendor patch.** `vendor/otel-cf-workers/src/spanprocessor.ts:84` invokes the `postProcessor` callback in `BatchTraceSpanProcessor.exportSpans()`. Without this 5-line patch, the `postProcessor` config is parsed by @microlabs but never called, which means `launchdarkly.project_id` resource attribute injection silently doesn't reach LD and the entire LD auth path breaks. The patch is committed in `vendor/otel-cf-workers/dist/` and tracked in `vendor/otel-cf-workers/VENDOR.md`. Test coverage at `test/lib/otel-postprocessor.spec.js` invokes `resolveOtelConfig(env).postProcessor([stubSpan])` directly and asserts the resource attribute is injected — guards against silent revert on future vendor re-syncs.

## Metrics-poller

The `rf-cf-metrics-poller` is a separate worker living at `metrics-poller/`. Runs on an hourly cron, executes three Cloudflare GraphQL Analytics queries (D1 storage bytes, KV stored bytes, Workers AI neurons), constructs OTel metric records, and POSTs them as OTLP/JSON to LaunchDarkly's `/v1/metrics` endpoint. Cloudflare account id sourced from `env.CF_ACCOUNT_ID` (declared as a plain var in `metrics-poller/wrangler.metrics.jsonc` — account ids are non-secret); the OTLP push is error-handled and structured-logs both network failures and non-2xx responses via `console.error` so the metric pipeline failure surfaces as a span attribute + log record. The poller carries the same OTel lib stack as the application workers (body capture, logs bridge, trace SDK) — it is self-observable through the same pipeline, with its own `flow.name=CronMetricsTick` span.

Three metrics emitted per tick:
- `cf.d1.storage_bytes` (per D1 database)
- `cf.kv.stored_bytes` (per KV namespace)
- `cf.ai.neurons` (per account, hourly)

Resource attributes include `cf.account_id` so LD can pivot by account.

## Dashboards

Dashboards are LD-UI configured (not in code). Draft queries for each panel are preserved in `docs/archived/handoffs/2026-05-11-observability-merge-prep.md` § 6.5 if needed. Four dashboards exist in the `rf-dialpad-sync` LD project as of 2026-05-12:

| Name | ID | Path |
|---|---|---|
| Flow Health (by flow.name) | `10015443` | `/dashboards/10015443` |
| Per-worker Health | `10015444` | `/dashboards/10015444` |
| Webhook + Integration Health | `10015445` | `/dashboards/10015445` |
| CF Binding Usage | `10015446` | `/dashboards/10015446` |

What each one covers:

1. **Live firehose / Flow Health** — fast trace stream filtered/grouped by `flow.name`. Use to spot traffic in real-time, drill into a specific flow's spans, or watch a deploy for regressions.
2. **CF Binding Usage** — D1 / KV / AI / Worker request rates derived from span aggregations (`db.system`, `db.name`, `cache.operation`, `ai.run` span names, etc.). Cross-references the hourly metrics-poller metrics for storage trend.
3. **Per-worker Health** — error rate, latency p50 / p95 / p99 per service, grouped by `service.name`. First port of call for Alert 3 (worker error rate, once alerts land).
4. **Webhook + Integration Health** — RF / Dialpad / Apollo / Krisp inbound webhook rates + Apollo enrichment outcomes. Consumes the `rf.event_type` and `dialpad.event_type` span attributes set in webhook handlers for per-event-type breakdowns.

(Plus an auto-generated `User Insights` dashboard the LD project ships with — frontend-RUM template, not used by our backend setup.)

## Pipeline failures (diagnostic recipes)

- **No traces in LD at all.** Verify `LD_SDK_KEY` secret is set on the affected worker (`wrangler secret list --config <worker>/wrangler.*.jsonc`). Check Cloudflare native observability for raw runtime errors — if `instrument()` errored at worker boot, you'll see it there. If `LD_SDK_KEY` is set and CF native is clean, check `otel.observability.app.launchdarkly.com` is reachable from the worker (LD outage check).

- **Traces present but no `flow.name`.** The handler didn't set the attribute. Grep for the route in `src/index.js` (or the equivalent in the affected worker), confirm `trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.X);` is at the top of the handler body, **before** any branching or early return.

- **Workflow traces missing.** Confirm the Workflow `run()` body calls `getWorkflowTracer('rf-mcp-cache-sync', '<tracer name>')` from `cache-worker/src/lib/bootstrap-otel.js` (NOT `trace.getTracer(...)` from `@opentelemetry/api`) and `await flushWorkflowSpans()` in its `finally` block. Without the explicit flush, the local `BasicTracerProvider`'s `BatchSpanProcessor` won't fire before the run context tears down and spans are dropped.

- **`http.response.body` missing on a fetch span.** Check `LOG_NO_BODY` / `OTEL_DISABLED` env vars (if either is set, body content is suppressed). Check the response `content-type` — non-text/JSON content-types (binary, images) are skipped. Check the response size — if `…[truncated, original >${MAX_BODY_BYTES} bytes]` appears at the end of `http.response.body`, the body was oversized and truncated.

- **Body-capture attributes empty on Workflow inner fetches.** Known limitation: body-capture stamps via `trace.getActiveSpan()` which reads from the global `ContextManager`. @microlabs's `instrument()` wraps fetch/scheduled handlers and registers the CF runtime's AsyncLocalStorage context manager, but Workflow `run()` bodies run OUTSIDE that wrap. The cache-worker's `bootstrap-otel.js` provides a Workflow-local `BasicTracerProvider` (intentionally NOT registered globally — would collide with @microlabs's WorkerTracerProvider), so `trace.getActiveSpan()` from inside an auto-instrumented fetch returns NoOp in Workflow context. Workaround: instrument Workflow-internal fetches with explicit structured `console.log` records (see `cache-worker/src/dialpad-list-client.js` for the per-page log shape). Logs land in LD's Logs tab without trace correlation (`spanID` empty) but are queryable by `service_name` + custom attributes.

- **Cross-worker traces don't link.** Verify the upstream worker's outbound fetch went through `@microlabs` — i.e., `instrument()` was active on the upstream's default export and the upstream worker has `LD_SDK_KEY` set. The upstream sets `traceparent` on the outbound request; the downstream's `acceptRemote: true` parent-based sampler picks it up. If the upstream has `LD_SDK_KEY` unset (test-isolation conditional fell to the bare handler), no `traceparent` is emitted and traces will appear as two unrelated trees.

- **Metrics-poller stale (no new metrics arriving).** See Alert 6 in `docs/observability-runbooks.md`. Common cause: expired `CF_API_TOKEN` secret.

## Known gaps (instrumentation work pending)

- **Inbound request body is NOT captured on the root fetchHandler span.** Body-capture wrapper only patches `globalThis.fetch` (outbound). Inbound MCP / webhook bodies are invisible in LD. Fix: small patch to read `request.clone().text()` at entry and stamp `http.request.body` on the root span. Sibling-copy across all 4 workers' `lib/body-capture.{js,ts}`.

- **MCP handler internal flow is NOT spanned.** A `/mcp/candidate-get` trace shows the inbound span + auto-instrumented D1 lookup + outbound RF fetch — but NOT the decisions in between (snapshot load, tier-1 fuzzy match, tier-2 RF routing, predicate build, response shaping). These have structured `console.log` lines (which DO appear in LD's Logs tab, correlated by `trace_id`) but no spans. Fix: add `tracer.startActiveSpan` calls at decision points inside `src/mcp/{candidate-search,candidate-get,job-pipeline,job-candidates-filter,candidate-call-notes,snapshot,resolvers,fuzzy}.js`. Estimated 2–4 h of work.

- **LD alerts not yet built.** Five alerts originally planned (D1 write storm, AI usage, per-worker error rate ×4, ingest near ceiling, cron stall). Dashboards above are live; alerts pending. SQL query bodies preserved in `docs/archived/handoffs/2026-05-11-observability-merge-prep.md` § 6.5.

## Reference

- Runbooks: `docs/observability-runbooks.md`
- Vendor patch: `vendor/otel-cf-workers/VENDOR.md`
