# Observability — LaunchDarkly via @microlabs/otel-cf-workers

Live reference for the observability pipeline. Read this when adding a new worker, entry handler, async-kickoff pattern, AI call site, or when an alert fires.

## Architecture

Four workers ship OTel traces + logs directly to LaunchDarkly Observability:
- `rf-dialpad-sync-dev` (main)
- `rf-mcp-cache-sync` (sync, Workflows)
- `rf-mcp-remote` (MCP)
- `rf-cf-metrics-poller` (hourly cron — pushes OTel metrics to LD /v1/metrics)

Traces via `@microlabs/otel-cf-workers`. Logs via parallel `@opentelemetry/sdk-logs` pipeline bridged from `console.*`. Auth: `launchdarkly.project_id=<LD_SDK_KEY>` as resource attribute. CF native observability stays at `head_sampling_rate: 0.1` as a no-cost fallback.

## Per-worker setup

Every worker's entry module installs in order:
1. `installBodyCapture()` — patches `globalThis.fetch` with body-stamping wrapper.
2. `installLogsBridge('<service-name>')` — registers global LoggerProvider + patches `console.*`.
3. `instrument(handler, resolveOtelConfig)` — @microlabs wraps the default export.

Sync worker additionally calls `bootstrapOtelForWorkflows('rf-mcp-cache-sync')` so Workflow contexts have a TracerProvider.

## Adding a new entry handler

1. Add constant to `src/lib/flow-names.js`.
2. At the top of the handler body: `trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.X);`.

## Adding a new async kickoff / webhook callback

1. Kickoff site: wrap callback URL in `makeAsyncCallbackUrl(baseUrl, extraParams)`.
2. Inbound handler: `const link = readInboundTraceLink(request); if (link) trace.getActiveSpan()?.addLink({ context: link });`.

Both helpers live in `src/lib/trace-link.js`.

## Adding a new Workers AI call site

Use `runAI(env, modelName, input, options?)` from `src/lib/ai-instrument.js`. Direct `env.AI.run` is banned.

## Adding a new Workflow

1. Wrap `run(event, step)` body in `tracer.startActiveSpan('Workflow<Name>', { attributes: { 'flow.name': FLOWS.WORKFLOW_X, 'workflow.id': event.instanceId } }, async (span) => { ... });`.
2. Wrap the `step` parameter with `instrumentedStep(step, '<service-name>', event.instanceId)` and use the wrapped one throughout.
3. Add `FLOWS.WORKFLOW_X` to `src/lib/flow-names.js` (or the equivalent in sync/mcp/poller).

The sync worker's `bootstrap-otel.js` initializes the global TracerProvider at module load for Workflow contexts; call `bootstrapOtelForWorkflows()` at the top of the entry module.

## Where to look first

- Slow / broken: Dashboard 3 (per-worker request health).
- Flow's body content / response shape: Dashboard 1 (live firehose) → drill in.
- Cost / usage: Dashboard 2 (CF binding usage).
- Webhook delivery rates / Apollo / external latency: Dashboard 4.
- Alert fired: `docs/observability-runbooks.md`.

Dashboards are user-side setup in the LD project `rf-dialpad-sync` — they are not deployed via code. Five metric-based alerts are configured in LD (D1 write storm, AI usage, worker error rate, LD ingest ceiling, sync-worker cron re-fire). Slack delivery targets `#rf-alerts`.

## Pipeline failures

- **Traces missing**: verify `LD_SDK_KEY` is set; check CF dashboard fallback for runtime errors.
- **Logs unstructured**: verify `installLogsBridge()` ran (it logs `LD_SDK_KEY missing` if it can't).
- **Workflow traces missing**: confirm `bootstrapOtelForWorkflows()` is called at module top.

## Reference

- Spec: `docs/archive/specs/2026-05-10-observability-launchdarkly-design.md`
- Plan: `docs/archive/plans/2026-05-10-observability-launchdarkly.md`
- Runbooks: `docs/observability-runbooks.md`
