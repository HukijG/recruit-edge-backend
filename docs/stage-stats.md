# Stage-movement stats plane

The event-driven CV-Sent / 1st-Interview pipeline: RF stage-moved webhooks →
enrichment against RF's transactional stage-movement store → an append-only
event log in a dedicated D1 → a latest-event-wins weekly aggregate pushed to
the office dashboard. Lives in `src/stage-stats/` (one coherent sphere) plus
the route/cron wiring in `src/index.js`.

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
                            verify X-RF-Webhook-Token (timing-safe)
                            enrich: stage-movement/list over a 14-day lookback
                            upsert ALL returned transitions → STAGE_EVENTS D1
                            ctx.waitUntil: recompute current London week → push
                                                          │
   POST {DASHBOARD_REMOTE_BASE,DASHBOARD_REMOTE_BASE_DEV}/api/remote/stats/stage-weekly
   X-Remote-Key — fan-out to BOTH targets, fully independent outcomes
                                                          │
GET /stats/stage-aggregate (X-Stats-Token) ←─ dashboard puller (10-min seed/heal)
POST /admin/stage-stats/{reconcile,backfill} (X-Stats-Token) ←─ ops
scheduled() hourly cron (7 * * * *) ─→ reconcile sweep + push
```

Push is the fast path (event → TV in seconds). Pull is the seed/heal path.
Both carry the same payload shape.

## Module map (`src/stage-stats/`)

| File | Role |
|------|------|
| `classify.js` | The stage-label sets (frozen copies, in LOCKSTEP with `company_dashboard/server/config/consultants.json`) + `isSubmittedStage` + `classifyTransition`. |
| `week.js` | DST-correct Europe/London Mon–Sun week windows via `Intl` part extraction (no dependency). |
| `rf-stage-client.js` | `stage-movement/list` fetch + `candidate/search` walk + RF timestamp parsing + the bounded burst backoff (3 attempts, 0.4s → 1.6s + jitter, retries 429/5xx/network). |
| `store.js` | The idempotent `ON CONFLICT` upsert + the two latest-event-wins aggregate queries. |
| `ingest.js` | The shared engine: `ingestCandidate` (fetch → classify → upsert) + `ingestWindow` (search walk → optional gate → per-candidate ingest, ~120ms spacing). Webhook, reconcile, and backfill all funnel through it so the paths cannot drift. |
| `push.js` | `recomputeAndPush` — current-week aggregate → POST to every configured target. Never throws. |
| `webhook.js` | The `POST /webhook/recruiterflow/stage-moved` handler. |
| `reconcile.js` | The hourly cron body + `POST /admin/stage-stats/reconcile`. |
| `backfill.js` | Cursor-batched `POST /admin/stage-stats/backfill`. |
| `pull.js` | `GET /stats/stage-aggregate`. |
| `stats-token.js` | The timing-safe `X-Stats-Token` gate shared by pull + the admin routes (fail closed when `STATS_PULL_TOKEN` is unset). |

## Counting semantics (canonical)

- **Submitted territory** is a denylist: a stage is submitted-or-beyond unless
  its trimmed, lowercased name is in `PRE_SUBMISSION_STAGES` or contains
  `"disqualif"`. Empty/whitespace/missing names are NOT submitted.
- **CV-Sent crossing**: `isSubmitted(to) && !isSubmitted(from)`. A missing
  `from` counts as not-submitted (first entry straight into submitted
  territory IS a crossing); stage-skipping jumps are crossings.
- **1st-Interview landing**: trimmed, lowercased `to` ∈ `FIRST_INTERVIEW_STAGES`.
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

### Stage-label lockstep

The label sets exist twice: `classify.js` (frozen constants, what actually
classifies) and `company_dashboard/server/config/consultants.json` (the
human-edited reference; that server only displays). **Edit both together,
then re-run the backfill** — `is_cv_cross` / `is_iv_landing` are denormalised
into D1 at write time and do not self-heal on a label change (the upsert's
`ON CONFLICT ... DO UPDATE` is what lets a re-run recompute them in place).

## D1: `rf-stage-events` (binding `STAGE_EVENTS`)

Owned (read+write) by the main worker. Migrations in
`migrations-stage-events/`. One table:

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
-- + (is_cv_cross, entered_ms) and (is_iv_landing, entered_ms) indexes
```

- The upsert is `INSERT ... ON CONFLICT DO UPDATE`: flags + stages update in
  place, `mover_rf_id` is `COALESCE`d (an attributed sighting is never
  overwritten by an unattributed one), `source`/`first_seen_ms` keep their
  first-sighting values. Replays and concurrent duplicates are no-op races.
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
| `/webhook/recruiterflow/stage-moved` | POST | `X-RF-Webhook-Token` (timing-safe vs `RF_WEBHOOK_SECRET`) | RF stage-moved events. Unparseable payloads are ACKed `200 {ok, ignored}` with a loud warn (no retry-storm); enrichment failure → 500 (RF may retry; the cron heals regardless). Responds `{ok: true, stored: N}`; the push runs in `ctx.waitUntil`. |
| `/stats/stage-aggregate?afterMs=&beforeMs=` | GET | `X-Stats-Token` (timing-safe vs `STATS_PULL_TOKEN`) | Caller-chosen window aggregate (§ wire contract below). 400 on missing/non-integer params or `afterMs >= beforeMs`. |
| `/admin/stage-stats/reconcile` | POST | `X-Stats-Token` | The cron sweep on demand (ops/testing). |
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
  upsert the same rows — the PK + ON CONFLICT makes this a no-op race.

## Reconcile (cron + manual)

Backstop for missed/failed webhooks. `scheduled()` (cron `7 * * * *`) runs
`ingestWindow` over previous-London-Monday → now, **gated** by the
reached-submission predicate (any search-row job's current stage in submitted
territory; a `disqualif*` stage judged by `previous_stage_details.
prev_stage_name`, unknown → keep) purely to bound RF detail calls, then pushes
unconditionally. The window reaches back to the PREVIOUS week's Monday so the
LAST-WEEK aggregate keeps healing across the weekly boundary.

Residual hole (narrow, accepted): an event is lost only if the webhook + RF
retries all failed AND the candidate's stage was reverted below submission
before any sweep ran AND no other job of theirs is in submitted territory AND
that state persists for the ~2 weeks the window keeps retrying. An ungated
backfill over the affected window recovers it exactly.

## Backfill

`POST /admin/stage-stats/backfill` body:
`{ afterMs, beforeMs, cursor?: 0, batchSize?: 100 (max 200) }` →
`{ ok, done, nextCursor, processed, stored, failed }`.

Each invocation re-runs the window's `candidate/search`, sorts ids ascending,
processes the first `batchSize` ids `> cursor` (UNGATED — for historical
windows the current stage no longer reflects what happened then), ~120ms
spacing. The operator loops until `done: true`, then calls reconcile once to
push. Idempotent — re-running any batch is harmless, and it is also the
recovery tool after a label change or D1 loss.

Subrequest budget: reconcile ≈ 5 search pages + ~100–200 gated detail calls +
per-candidate D1 batches; backfill ≤ 200 ids/batch — both sized for the
Workers Paid 1000-subrequest budget (a 100-id batch ≈ 205 subrequests, which
also makes any plan downgrade fail loudly, not silently).

## Wire contracts (FROZEN — shared with the office dashboard repo)

### Push: worker → dashboard

`POST {target}/api/remote/stats/stage-weekly` with `X-Remote-Key:
{DASHBOARD_REMOTE_KEY}`, fanned out to `DASHBOARD_REMOTE_BASE` (prod,
required — unset skips pushing entirely with a warn) and
`DASHBOARD_REMOTE_BASE_DEV` (optional extra target; never gates anything):

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
| `404` | target runs a pre-stats dashboard build — info, no retry |
| 5xx / network | one immediate retry, then give up (the puller heals) — prod: warn, dev: info (a down dev container is its steady state) |

### Pull: dashboard → worker

`GET /stats/stage-aggregate?afterMs=<int>&beforeMs=<int>` with
`X-Stats-Token` → the same body shape with the window echoed back. The window
is caller-chosen: current week (the dashboard's 10-min puller), previous week
(the LAST-WEEK toggle), anything else (audits).

## Secrets / vars

| Name | Purpose |
|---|---|
| `RF_WEBHOOK_SECRET` | shared with the other RF webhooks; presented as `X-RF-Webhook-Token` |
| `DASHBOARD_REMOTE_BASE` | prod push target (`https://music.example.com`) — unset ⇒ no pushes (warn) |
| `DASHBOARD_REMOTE_BASE_DEV` | optional dev push target (`https://music-dev.example.com`) |
| `DASHBOARD_REMOTE_KEY` | `X-Remote-Key` for both push targets (same value the music worker holds) |
| `STATS_PULL_TOKEN` | gates `/stats/stage-aggregate` + `/admin/stage-stats/*` |

## Observability

Flow names: `WebhookRecruiterflowStageMoved` (+ `rf.event_type='stage_moved'`
and the payload's from/to as span attributes), `StatsStageAggregatePull`,
`StatsStageReconcile` (also the cron's flow), `StatsStageBackfill`. Structured
logs: per-webhook `{candidateId, stored, tookMs}`; per-push
`{windowStartMs, cvTotal, ivTotal, status, target}`; per-reconcile
`{candidates, gated, stored, failed}`. Low volume — no `PATH_SAMPLING_RULES`
entry; the existing webhook-health panels pick up the new `rf.event_type`.

## Failure / healing matrix

| Failure | Healed by | Worst-case staleness |
|---|---|---|
| webhook not delivered | hourly reconcile | ~1h |
| enrichment RF call fails (500 to RF) | RF retry, else reconcile | ~1h |
| push lost | next push or the dashboard's 10-min puller | ≤10 min |
| worker down | reconcile on recovery (2-week window) | outage + ≤1h |
| dashboard down | its boot-seed pull on restart | restart |
| Monday rollover race | dashboard 409s `window_mismatch` + fires its puller | seconds–minutes, benign |
| label change | edit both label sets + re-run backfill | operator-driven |
| D1 wiped | re-run backfill over any horizon | operator-driven |
