# Observability alert runbooks

Each alert in `#rf-alerts` is paired with a short runbook of what to check and how to respond.

## Alert 1: D1 write storm (>5000 writes/min)

**What it means:** Some path is writing > 5k rows/min to D1. Normal traffic peaks ~500/min. Likely candidates: a re-enabled sync-worker cron without unchanged-row gating, or a runaway loop in main worker.

**First checks:**
1. LD Dashboard 2 → D1 writes/min panel. Which database?
2. Filter traces by that `db.binding` in the spike window. Which `flow_name` is dominating?
3. If `flow_name=CronTailSync` → see Alert 5 runbook.
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
2. Top 5 erroring endpoints → which `flow_name` is failing?
3. Drill into a failing trace. What's the error span's status message?

**Mitigation:** Roll back or fix-forward depending on the failure.

## Alert 4: LD ingest near free-tier ceiling

**Mitigation options:**
1. Drop head sampling rate from 1.0 to 0.5 in each worker's `resolveOtelConfig`.
2. Upgrade LD plan (overage $1.50/M).
3. Trim a noisy `flow_name`'s sampling specifically.

## Alert 5: Sync-worker cron unexpectedly fired

**Action:**
1. Disable cron immediately in `wrangler.sync.jsonc` (remove cron trigger). Deploy.
2. Verify alert stops firing.
3. Coordinate with the unchanged-row-gating work before re-enabling.

## Operational note: `LOG_NO_BODY` kill switch

If body capture is leaking sensitive data through a flow that's actively being debugged (e.g., a one-off support task that touches normally-redacted-but-currently-cleartext data), disable body capture without redeploying by setting the secret on the affected worker(s):

```bash
# Enable kill switch on main worker
wrangler secret put LOG_NO_BODY        # paste: 1
# Sync worker
wrangler secret put LOG_NO_BODY --config sync-worker/wrangler.sync.jsonc        # paste: 1
# MCP worker
wrangler secret put LOG_NO_BODY --config mcp-worker/wrangler.mcp.jsonc          # paste: 1
```

The body-capture wrapper checks `env.LOG_NO_BODY === '1'` on every invocation and short-circuits when set. Spans + logs still ship to LD, but without `http.request.body` / `http.response.body` attributes.

To re-enable body capture:
```bash
wrangler secret delete LOG_NO_BODY
wrangler secret delete LOG_NO_BODY --config sync-worker/wrangler.sync.jsonc
wrangler secret delete LOG_NO_BODY --config mcp-worker/wrangler.mcp.jsonc
```

No redeploy needed; secret changes propagate within seconds.

The wrapper does **NOT** retroactively scrub spans already emitted while the switch was off — incident response on already-leaked data must go through LD's data deletion path separately.
