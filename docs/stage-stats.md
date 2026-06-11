# Stage-movement stats plane

The event-driven CV-Sent / 1st-Interview pipeline: RF stage-moved webhooks →
enrichment against RF's transactional stage-movement store → an append-only
event log in a dedicated D1 → a latest-event-wins weekly aggregate pushed to
the office dashboard. Lives in `src/stage-stats.js` (one feature module, like
`cold-call.js` / `krisp.js`), with all RF calls in `src/rf-client.js` and the
route/cron wiring in `src/index.js`.

The consumer is the office dashboard — a separate repo (a Rust server driving an
office TV board). The wire contracts below are shared and FROZEN — changing
either side requires touching both repos.

## Why this shape

RF's search index is a lagging projection of its transactional store (measured
up to ~1 hour behind the stage-movement endpoint). RF webhooks for stage moves
deliver within ~5 minutes, and the `stage-movement/list` endpoint is instantly
consistent and carries the mover — so stage movements are event-driven:
webhook → enrich → store → push. No Durable Object, no WebSocket; pure
request/response.

## Topology

```
RF stage-moved webhook ─→ POST /webhook/recruiterflow/stage-moved
                            verify X-RF-Webhook-Token (timing-safe; 401s are warn-logged)
                            enrich: stage-movement/list over a 14-day lookback
                            classify per job (pipeline-positional, see below)
                            conditional upsert → STAGE_EVENTS D1
                            ctx.waitUntil: recompute + push — ONLY if rows changed
                                                          │
   POST {DASHBOARD_REMOTE_BASE?,DASHBOARD_REMOTE_BASE_DEV?}/api/remote/stats/stage-weekly
   X-Remote-Key — fan-out to every CONFIGURED target, fully independent outcomes
                                                          │
GET /stats/stage-aggregate (X-Stats-Token) ←─ dashboard puller (30-min seed/heal)
POST /admin/stage-stats/{reconcile,backfill} (X-Stats-Token) ←─ ops
scheduled() hourly cron (7 * * * *) ─→ waterlined reconcile sweep (+ push if changed)
```

Push is the fast path (event → TV in seconds). Pull is the seed/heal path.
Both carry the same payload shape.

## Module map

| Where | Role |
|------|------|
| `src/stage-stats.js` | The whole plane, in sections: London week windows (`Intl` part extraction, DST-correct) · pipeline-positional classification + the per-job pipeline KV cache · the conditional `ON CONFLICT` upsert + the two latest-event-wins aggregate queries · `sync_state` (reconcile waterline) · the `X-Stats-Token` gate · the shared ingest engine (`ingestCandidate` / `ingestWindow` — webhook, reconcile and backfill all funnel through it so the paths cannot drift) · `recomputeAndPush` · the four route handlers. |
| `src/rf-client.js` | The RF calls: `fetchStageMovements` (transactional `stage-movement/list`), `fetchRFJobPipeline` (shared with the MCP layer), `searchCandidatesByPredicateOnly` (shared paginated `candidate/search`), `parseRFTimestamp` / `formatRFSeconds`, and `rfRequestWithRetry` (bounded burst backoff: 3 attempts, 0.4s → 1.6s + jitter, retries 429/5xx/network). |
| `src/index.js` | Route dispatch (4 routes, `flow.name` at entry) + `scheduled()` for the hourly cron. |
| `migrations-stage-events/` | The STAGE_EVENTS schema (`0001` table, `0002` sync_state + covering partial indexes). |

## Counting semantics (canonical)

Classification is **positional, per job** — the same semantics as the MCP
pipeline tools (`src/mcp/job-pipeline.js` + `pipeline-index.js`), which are
canonical for this RF tenant:

- Each job's RF pipeline (`/job/pipeline` → `summary[]`) is an ORDERED stage
  list. **Submitted territory** is every stage at or after the exact
  `'CV Sent'` landmark IN THAT JOB'S OWN ORDER. No global label lists — a
  custom stage is judged by its position, not its name.
- `'Disqualified'` is off the linear ladder (exact match): never submitted
  territory, judged separately.
- **CV-Sent crossing**: `to` is at/after the landmark and `from` is not. A
  missing `from` is not-submitted (first entry straight into submitted
  territory IS a crossing); stage-skipping jumps are crossings.
- **1st-Interview landing**: `to` is THE first interview stage of that job's
  pipeline — the first stage at/after the landmark whose name contains
  `interview` (case-insensitive). Handles `Client Interview 1` vs
  `1st Interview` vs any custom label with no allowlist.
- **Structural anomalies never fabricate**: a pipeline without the landmark
  (job not CV-tracked), a deleted job (pipeline 404), or a stage name absent
  from the live pipeline (renamed/deleted since) stores the row with both
  flags 0 and a warn-once — the warn is the operator's signal. Transient
  pipeline-fetch failures instead fail the candidate atomically (no rows
  written) so the sweep retries it.
- **Attribution** is the transition's `stage_moved_by.id` (the mover, never
  the job owner).
- **Aggregate**: per (candidate_id, job_id) pair, the most recent qualifying
  event across ALL stored history is THE event — its time and its mover. A
  window `[after, before)` counts a pair iff its latest qualifying event falls
  inside, attributed to that event's mover. Consequences: back-and-forth never
  double-counts; latest truth wins even across weeks; a reverted crossing
  still counts; the same candidate on two jobs is two counts; NULL-mover
  events occupy their pair's latest slot (returned as `rfUserId: null`, which
  the dashboard drops at mapping).

### Pipeline cache + landmark lockstep

Pipeline stage lists are near-immutable structure → memoised per
sweep/webhook invocation and KV-cached for a day (landmarked jobs: zero
fetches on warm hours; landmark-less jobs: one heal-refetch per invocation,
sweep or webhook — the heal can't tell stale-no-landmark from
genuinely-no-landmark)
(`stagestats:pipeline:<jobId>` in the `SYNC_STATE` KV). When a transition
references a stage the cached list doesn't know, OR the cached list has no
landmark (a job made CV-tracked mid-TTL), the list is refetched fresh once —
self-heal for pipeline edits inside the TTL, in both classification and the
reconcile gate. An empty `summary[]` from RF is treated as transient (thrown,
never cached): a cached empty list would mis-classify the job's every
transition for a full TTL. Names are trimmed at the boundary; pipeline
fetches and the reconcile/backfill search pages run under the burst backoff
(3 attempts, 429/5xx/network).

The `SUBMITTED_LANDMARK` constant (`'CV Sent'`) exists twice — in
`src/stage-stats.js` and as the MCP layer's landmark in
`src/mcp/job-pipeline.js`. Keep them in LOCKSTEP. The classification flags
are denormalised into D1 at write time and do not self-heal on a logic or
pipeline change: **re-run the backfill** over the horizon you care about (the
conditional upsert recomputes flags in place and is free for rows that don't
change).

## D1: `rf-stage-events` (binding `STAGE_EVENTS`)

Owned (read+write) by the main worker. Migrations in
`migrations-stage-events/`. Two tables:

```sql
stage_events (
  candidate_id, job_id, entered_raw,   -- PK; entered_raw is RF's VERBATIM string
  entered_ms,                          -- parsed UTC epoch ms (window math only)
  from_stage, to_stage,                -- to_stage '' when RF omits it (NOT NULL)
  mover_rf_id,                         -- NULL when unattributed
  is_cv_cross, is_iv_landing,          -- denormalised classification flags
  source,                              -- 'webhook' | 'reconcile' | 'backfill' (first sighting)
  first_seen_ms
)
-- + two COVERING PARTIAL indexes (migration 0002), one per flag:
--   (candidate_id, job_id, entered_ms, mover_rf_id, entered_raw) WHERE <flag> = 1
-- the aggregate queries run entirely inside them (verified: SCAN ... USING
-- COVERING INDEX) — one index row read per flagged event, no table lookups.

sync_state (key PRIMARY KEY, value, updated_ms)   -- 'reconcile_waterline_ms'
```

- The upsert is `INSERT ... ON CONFLICT DO UPDATE ... WHERE <anything
  changed>`: flags + stages update in place, `mover_rf_id` is `COALESCE`d (an
  attributed sighting is never overwritten by an unattributed one; a
  DIFFERING attributed sighting wins — RF corrected the fact),
  `source`/`first_seen_ms` keep their first-sighting values — and an
  UNCHANGED replay writes **zero** D1 rows. Replays and concurrent duplicates
  are free no-op races, and the summed per-statement `changes()` is an honest
  "did anything change" signal that gates the push.
- The aggregate's inner scan deliberately covers ALL flagged history, not
  just the window: a pair's most recent event decides which week (if any) the
  pair counts in, so a last-week pull must see this week's events to know a
  last-week crossing was superseded. Window-bounding the scan would resurrect
  superseded events.
- EVERY transition the enrichment returns is stored (pre-submission moves
  too) — volume is trivial and the raw from/to history is what makes future
  metrics and reclassification possible.
- Known limit, inherited from the identity: RF's `entered` is
  seconds-precision, so two moves of the same pair within one second collapse
  to one row. Latest-event-wins makes this nearly harmless.
- Rows are facts about the past — consistent with the repo's "cache only
  immutable data in D1" rule.

## Routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/webhook/recruiterflow/stage-moved` | POST | `X-RF-Webhook-Token` (timing-safe vs `RF_WEBHOOK_SECRET`) | RF stage-moved events. 401s are **warn-logged** (`tokenPresent`/`secretConfigured`) and carry `rf.event_type` on the span — a misconfigured recipe is visible, not silent. Unparseable payloads are ACKed `200 {ok, ignored}` with a loud warn (no retry-storm); enrichment failure → 500 (RF may retry; the cron heals regardless). Responds `{ok, stored, changed}`; the push runs in `ctx.waitUntil` only when `changed > 0`. |
| `/stats/stage-aggregate?afterMs=&beforeMs=` | GET | `X-Stats-Token` (timing-safe vs `STATS_PULL_TOKEN`) | Caller-chosen window aggregate (§ wire contract below). 400 on missing/non-integer params or `afterMs >= beforeMs`. |
| `/admin/stage-stats/reconcile` | POST | `X-Stats-Token` | The cron sweep on demand (ops/testing). Response includes `windowAfterMs` + `waterlineAdvanced`. |
| `/admin/stage-stats/backfill` | POST | `X-Stats-Token` | Cursor-batched historical walk (see below). |

All three token-gated routes are machine-to-machine (the dashboard server /
operator curl) — NOT user-facing, so per `docs/security.md` they use a
shared-token header, not Cloudflare Access. All compares are timing-safe
(`src/lib/timing-safe-equal.js`) and fail closed on an unset secret.

## The webhook path

- The RF hook is configured to fire on stage moves into CV-Sent-and-beyond
  stages — but correctness NEVER relies on RF's stage filter; classification
  is server-side. The filter only trims volume.
- RF's payload carries `event_time` / `from_stage` / `to_stage` / `candidate`
  / `job` and **no mover** — which is why the handler ignores the payload's
  own transition fields (they become span attributes only) and enriches
  against `stage-movement/list` instead. One row shape, one identity.
- The enrichment window is 14 days (`ENRICH_LOOKBACK_MS`): one cheap GET
  returns all the candidate's recent transitions, so a webhook for one move
  also self-heals previously-missed moves for the same candidate.
- Two near-simultaneous webhooks for the same candidate both enrich and both
  upsert the same rows — the PK + ON CONFLICT makes this a no-op race, and
  whichever lands second sees `changed = 0` and skips its push. RF flushing
  queued deliveries for already-stored moves is the same harmless pattern.

## Reconcile (cron + manual, waterlined)

Backstop for missed/failed webhooks. `scheduled()` (cron `7 * * * *`) runs
`ingestWindow` over `[waterline − 3h, now]`, where the waterline
(`sync_state.reconcile_waterline_ms`) is the start instant of the last sweep
that finished with zero failed candidates:

- RF's `candidate/search` `last_activity` filter is DAY-granular, so candidate
  discovery is floored a day below the window start; the per-candidate
  stage-movement window (seconds precision) does the real bounding and the
  conditional upsert dedupes below the waterline for free.
- The 3h overlap absorbs RF's ~1h search-index lag and `entered`-vs-visibility
  skew.
- A sweep with any transiently-failed candidate HOLDS the waterline (the next
  hour re-covers the same window). Structural anomalies (no landmark, deleted
  job, ghost stage) never fail candidates, so they cannot pin it.
- Bootstrap (no stored waterline — first deploy, or after deleting the row to
  force a deep sweep): previous-London-Monday → now, which is also the
  horizon the dashboard's LAST-WEEK toggle reads.
- A candidate/search that overflows the 50-page cap (`truncated`) also HOLDS
  the waterline — advancing over never-ingested candidates would be permanent
  silent loss. The warn names the window. Recovery is NOT just a backfill —
  see "search window overflows the cap" in the failure matrix (backfill never
  moves the waterline, and deleting the row re-bootstraps a BIGGER window).
- The sweep is **gated** by the reached-submission predicate — positional,
  per job, fed by the same pipeline cache as classification: any search-row
  job whose current stage sits at/after its own landmark (a `Disqualified`
  current stage judged by `previous_stage_details.prev_stage_name`, unknown →
  keep). The gate errs toward keeping; jobs without the landmark never
  qualify. It exists purely to bound RF detail calls.
- Pushes only when the sweep changed rows.

Residual hole (narrow, accepted): an event is lost only if the webhook + RF
retries all failed AND the candidate's stage was reverted below submission
before any sweep ran AND no other job of theirs is in submitted territory AND
that state persists until the waterline passes. An ungated backfill over the
affected window recovers it exactly.

## Backfill

`POST /admin/stage-stats/backfill` body:
`{ afterMs, beforeMs, cursor?: 0, batchSize?: 100 (max 200) }` →
`{ ok, done, nextCursor, processed, stored, changed, failed, truncated }`.
`truncated: true` means the window's search overflowed the 50-page cap —
`done` covers only what the search returned; shrink the window and re-run.

Each invocation re-runs the window's `candidate/search`, sorts ids ascending,
processes the first `batchSize` ids `> cursor` (UNGATED — for historical
windows the current stage no longer reflects what happened then), ~120ms
spacing. The operator loops until `done: true`; delivery then comes from the
dashboard's puller (30-min + boot seed) or the next ingest that changes rows
— the push path is change-gated, so a reconcile after a backfill only pushes
if its own sweep changed something. Idempotent — re-running any batch is harmless (settled rows are
zero-write no-ops), and it is also the recovery tool after a classification
change, a pipeline restructure, or D1 loss. It never touches the reconcile
waterline.

Subrequest budget: reconcile ≈ 5 search pages + gated detail calls +
per-distinct-job pipeline fetches (KV-cached, so ~zero on warm hours) +
per-candidate D1 batches; backfill ≤ 200 ids/batch — both sized for the
Workers Paid 1000-subrequest budget (a 100-id batch ≈ 205 subrequests, which
also makes any plan downgrade fail loudly, not silently).

## Wire contracts (FROZEN — shared with the office dashboard repo)

### Push: worker → dashboard

`POST {target}/api/remote/stats/stage-weekly` with `X-Remote-Key:
{DASHBOARD_REMOTE_KEY}`, fanned out to every configured target —
`DASHBOARD_REMOTE_BASE` (prod) and/or `DASHBOARD_REMOTE_BASE_DEV` (dev
container). The targets are symmetric; with neither set (or no key) pushing
is skipped with a warn. **Staged cutover**: only the dev base is configured
until the prod dashboard build is verified; redirecting to prod is purely a
secret change (set `DASHBOARD_REMOTE_BASE`), no deploy.

```json
{
  "schema": 1,
  "windowStartMs": 1780873200000,   // current Mon 00:00 Europe/London (UTC ms)
  "windowEndMs":   1781478000000,   // next Mon 00:00 Europe/London
  "asOfMs":        1781089200123,   // stamped AFTER the D1 read (orders racing pushes)
  "cvSent":          [ { "rfUserId": 900005, "count": 3 } ],
  "firstInterviews": [ { "rfUserId": 900005, "count": 2 } ]
}
```

Counts are per RF user id, unfiltered (NULL movers included as
`rfUserId: null`); the dashboard owns mapping + `show_on` filtering and
zero-fills absent consultants. Per-target outcomes (independent; one target
never affects the other):

| Response | Worker behaviour |
|---|---|
| `200 {ok:true}` | applied — info log |
| `409 reason=window_mismatch` / `stale` | expected around rollovers / racing pushes — info, no retry |
| `409 reason=unconfigured` | dashboard running without consultants config — **warn** (operator-actionable), no retry |
| `404` / `405` | target runs a pre-stats dashboard build (its static fallback answers `GET,HEAD` only, so a POST gets 405 — observed live 2026-06-11) — info, no retry |
| 5xx / network | one immediate retry, then give up (the puller heals) — prod: warn, dev: info (a down dev container is its steady state) |

### Pull: dashboard → worker

`GET /stats/stage-aggregate?afterMs=<int>&beforeMs=<int>` with
`X-Stats-Token` → the same body shape with the window echoed back. The window
is caller-chosen: current week (the dashboard's 30-min puller), previous week
(the LAST-WEEK toggle), anything else (audits).

## Secrets / vars

| Name | Purpose |
|---|---|
| `RF_WEBHOOK_SECRET` | shared with the other RF webhooks; presented as `X-RF-Webhook-Token` |
| `DASHBOARD_REMOTE_BASE` | prod push target (e.g. `https://dashboard.example.com`) — UNSET during the staged cutover (dev-only pushing); set it to redirect to prod |
| `DASHBOARD_REMOTE_BASE_DEV` | dev push target (e.g. `https://dashboard-dev.example.com`) |
| `DASHBOARD_REMOTE_KEY` | `X-Remote-Key` for both push targets (same value the music worker holds) |
| `STATS_PULL_TOKEN` | gates `/stats/stage-aggregate` + `/admin/stage-stats/*` |

## Observability

Flow names (search these in LD as `flow.name`):
`WebhookRecruiterflowStageMoved`, `StatsStageAggregatePull`,
`StatsStageReconcile` (also the cron's flow), `StatsStageBackfill`. The
webhook stamps `rf.event_type='stage_moved'` BEFORE auth — auth-failed and
unparseable deliveries still surface on Dashboard 4 (webhook + integration
health) — and adds the payload's from/to as span attributes after parse.
Structured logs: 401s warn with `{tokenPresent, secretConfigured}`;
per-webhook `{candidateId, stored, changed, tookMs}`; per-push
`{windowStartMs, cvTotal, ivTotal, status, target}`; per-reconcile
`{candidates, gated, stored, changed, failed, windowAfterMs,
waterlineAdvanced}`; classification anomalies warn-once per job. Low volume —
no `PATH_SAMPLING_RULES` entry.

**LD-UI step (operator, once):** the four dashboards are provisioned in the
LD UI, not in code — Dashboard 4's per-event-type panels need
`stage_moved` added, and Dashboard 3 a row for the three `StatsStage*` flows,
or this plane stays invisible there even though the spans flow.

## Failure / healing matrix

| Failure | Healed by | Worst-case staleness |
|---|---|---|
| webhook not delivered | hourly reconcile | ~1h |
| enrichment RF call fails (500 to RF) | RF retry, else reconcile | ~1h |
| push lost | next push or the dashboard's 30-min puller | ≤30 min |
| worker down | reconcile on recovery (waterline never advanced — the gap window is re-swept) | outage + ≤1h |
| dashboard down | its boot-seed pull on restart | restart |
| Monday rollover race | dashboard 409s `window_mismatch` + fires its puller | seconds–minutes, benign |
| pipeline restructure / classification change | warn-once surfaces ghosts; KV refetch self-heals renames + newly-CV-tracked jobs; re-run backfill to recompute flags | operator-driven |
| search window overflows the 50-page cap persistently | hourly truncation warn + waterline held. Backfill the window (cursor-batched), then MANUALLY advance the waterline: `wrangler d1 execute rf-stage-events --remote --command "INSERT INTO sync_state (key, value, updated_ms) VALUES ('reconcile_waterline_ms', '<end of the BACKFILLED window, epoch ms>', <now-ms>) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_ms = excluded.updated_ms"`. Do NOT delete the row — that re-bootstraps to prev-Monday, a strictly bigger window, still truncated, still pinned | operator-driven |
| D1 wiped | re-run backfill over any horizon (delete the waterline row to force a deep reconcile) | operator-driven |
