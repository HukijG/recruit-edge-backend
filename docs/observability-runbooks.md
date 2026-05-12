# Observability alert runbooks

Each alert in `#rf-alerts` is paired with a short runbook of what to check and how to respond.

**Dashboard URLs** (paste actual LD URLs after the dashboards are provisioned in the LD UI):
- Dashboard 1 — Live firehose: `<set after LD UI dashboards are provisioned>`
- Dashboard 2 — CF binding usage: `<set after LD UI dashboards are provisioned>`
- Dashboard 3 — Per-worker request health: `<set after LD UI dashboards are provisioned>`
- Dashboard 4 — Webhook + integration health: `<set after LD UI dashboards are provisioned>`

## Alert 1: D1 write storm (>5000 writes/min)

**What it means:** Some path is writing > 5k rows/min to D1. Normal traffic peaks ~500/min. Likely candidates: a re-enabled cache-worker cron without unchanged-row gating, or a runaway loop in main worker.

**First checks:**
1. LD Dashboard 2 → D1 writes/min panel. Which database (`RF_MCP_CACHE` or `USERS_DB`)?
2. Filter traces by the corresponding `db.name` attribute (the @microlabs D1 auto-instrumentation tags every D1 span with `db.name=<bindingName>`, `db.system='Cloudflare D1'`, `db.operation=<run|all|batch|...>`). Which `flow.name` is dominating in the spike window?
3. If `flow.name=CronTailSync` → see Alert 5 runbook.
4. Otherwise check whether a webhook is replaying / recursing.

**Mitigation:** Roll back latest deploy if it correlates. Otherwise: disable the responsible cron / pause the webhook at source.

## Alert 2: Workers AI usage > 500 units/hour

**First checks:**
1. LD Dashboard 2 → AI calls/hour by model. One model dominating?
2. Check whether `WebhookKrisp` deliveries spiked (cold calls drive AI).
3. Filter `traces WHERE span_name='ai.run'`. Repeated identical inputs?

**Mitigation:** If looping, disable the offending flow.

## Alert 3: Worker error rate > 5%

**First checks:**
1. LD Dashboard 3 → row for the alerting service.
2. Top 5 erroring endpoints → which `flow.name` is failing?
3. Drill into a failing trace. What's the error span's status message?

**Mitigation:** Roll back or fix-forward depending on the failure.

## Alert 4: LD ingest near free-tier ceiling

**Mitigation options:**
1. Drop head sampling rate from 1.0 to 0.5 in each worker's `resolveOtelConfig`.
2. Upgrade LD plan (overage $1.50/M).
3. Trim a noisy `flow.name`'s sampling specifically.

## Alert 5: Cache-worker cron unexpectedly fired

**Action:**
1. Disable cron immediately in `cache-worker/wrangler.cache.jsonc` (remove cron trigger). Deploy.
2. Verify alert stops firing.
3. Coordinate with the unchanged-row-gating work before re-enabling.

## Alert 6: Metrics-poller silence (> 2 hours since last tick)

**What it means:** The hourly `rf-cf-metrics-poller` cron either has not fired or its emission has not reached LD for more than two hours. Either way, the D1 storage / KV stored bytes / Workers AI neurons panels on Dashboard 2 are going stale.

**Trigger:** Absence of a `flow.name=CronMetricsTick` span (or absence of `cf.d1.storage_bytes` metric emissions to LD) for > 2 hours.

**First checks:**
1. LD live tail for `service.name='rf-cf-metrics-poller'`. When was the last `CronMetricsTick` span?
2. Cloudflare dashboard → Workers → `rf-cf-metrics-poller` → Cron Triggers tab. Has the cron continued firing on schedule? If CF shows recent fires but LD has nothing → it's the OTLP push that's broken.
3. `CF_API_TOKEN` expired? Issue a manual GraphQL query against `https://api.cloudflare.com/client/v4/graphql` with the token to verify auth.
4. `CF_ACCOUNT_ID` correct in `metrics-poller/wrangler.metrics.jsonc` vars block?
5. Recent `console.error` records from `rf-cf-metrics-poller` in LD logs view? Two error-handled paths surface as `console.error`: `{ source: 'metrics-poller', message: 'OTLP push failed (network)', error }` and `{ source: 'metrics-poller', message: 'OTLP push HTTP error', status }`.

**Mitigation:**
- Rotate `CF_API_TOKEN` if expired. `wrangler secret put CF_API_TOKEN --config metrics-poller/wrangler.metrics.jsonc`.
- If cron deregistered, `wrangler deploy --config metrics-poller/wrangler.metrics.jsonc` re-registers it from the config.
- If persistent and you want to force a tick to confirm fix, trigger a manual run via `wrangler dispatch` against the poller worker.

## Alert 7: Cache-worker Workflow stuck (open > 1h without completion span)

**What it means:** A `FullRebuildWorkflow` or `PipelineRebuildWorkflow` instance has been running for over an hour without a corresponding completion / error span on the same `workflow.id`. Either the Workflow is hung, has been retrying indefinitely, or its completion span never emitted.

**Trigger:** Workflow span (`WorkflowFullRebuild` or `WorkflowPipelineRebuild`) started > 1h ago AND no terminal span on the same `workflow.id`.

**First checks:**
1. Cloudflare dashboard → Workers → `rf-mcp-cache-sync` → Workflows tab → `RF_FULL_REBUILD` or `RF_PIPELINE_REBUILD` instances list. Find the stuck instance ID. What's its CF-side status (Running, Errored, Queued)?
2. LD traces filtered by `workflow.id='<stuck-instance-id>'`. What's the last step name with a span? Last span timestamp? Is the last step in a retry loop (multiple per-attempt spans with the same step name)?
3. Check `step.do` error attributes on the last span. Hung waiting on RF? Hung in `step.sleep`?

**Mitigation:**
- `wrangler workflows instances terminate <workflow-name> <instance-id>` to terminate the stuck instance, or `wrangler workflows instances cancel <workflow-name> <instance-id>` for a graceful cancel.
- Re-trigger via `POST /admin/full-rebuild` (full) or `POST /admin/pipeline-rebuild?job_id=<id>` (per-job) once the root cause is understood.
- If the stuck step was an RF call, check RF status page before re-triggering.

## Operational note: `LOG_NO_BODY` kill switch (body content only)

If body capture is leaking sensitive data through a flow that's actively being debugged (e.g., a one-off support task that touches normally-redacted-but-currently-cleartext data), disable body capture **without redeploying** by setting the secret on the affected worker(s):

```bash
# Main worker
wrangler secret put LOG_NO_BODY                                              # paste: 1
# Cache worker
wrangler secret put LOG_NO_BODY --config cache-worker/wrangler.cache.jsonc     # paste: 1
# MCP worker
wrangler secret put LOG_NO_BODY --config mcp-remote/wrangler.mcp.jsonc       # paste: 1
# Metrics-poller
wrangler secret put LOG_NO_BODY --config metrics-poller/wrangler.metrics.jsonc # paste: 1
```

The body-capture wrapper checks `env.LOG_NO_BODY === '1'` on every invocation and short-circuits when set. Spans + logs still ship to LD, but without `http.request.body` / `http.response.body` attributes.

To re-enable body capture:
```bash
wrangler secret delete LOG_NO_BODY
wrangler secret delete LOG_NO_BODY --config cache-worker/wrangler.cache.jsonc
wrangler secret delete LOG_NO_BODY --config mcp-remote/wrangler.mcp.jsonc
wrangler secret delete LOG_NO_BODY --config metrics-poller/wrangler.metrics.jsonc
```

No redeploy needed; secret changes propagate within seconds.

The wrapper does **NOT** retroactively scrub spans already emitted while the switch was off — incident response on already-leaked data must go through LaunchDarkly's data deletion path separately.

## Operational note: `OTEL_DISABLED` kill switch (emergency, wholesale)

The wholesale emergency lever. Use this when:
- LD itself is misbehaving (e.g., the platform is storing data it shouldn't even by our trust posture).
- You need to cut emission entirely while filing an LD deletion request.
- You suspect the observability pipeline is interfering with worker behaviour and want to isolate.

`OTEL_DISABLED=1` short-circuits **both** the body-capture fetch wrapper and the logs-bridge `console.*` wrap at the top of each helper. The worker continues to run normally; observability emission stops. Cloudflare native observability at 10% sampling continues regardless (it does not go through our OTel pipeline).

```bash
# Main worker
wrangler secret put OTEL_DISABLED                                              # paste: 1
# Cache worker
wrangler secret put OTEL_DISABLED --config cache-worker/wrangler.cache.jsonc     # paste: 1
# MCP worker
wrangler secret put OTEL_DISABLED --config mcp-remote/wrangler.mcp.jsonc       # paste: 1
# Metrics-poller
wrangler secret put OTEL_DISABLED --config metrics-poller/wrangler.metrics.jsonc # paste: 1
```

Re-enable by deleting the secret on each worker (mirrors the `LOG_NO_BODY` delete pattern above). Propagation is seconds, no redeploy.

**Distinction:**
- `LOG_NO_BODY=1` — observability stays on, body content is stripped. Use for targeted PII concerns.
- `OTEL_DISABLED=1` — observability turns off wholesale (no traces, no logs, no body content). Use only when you actually need emission to stop.
