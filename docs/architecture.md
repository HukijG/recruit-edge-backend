# Architecture & Data Flow

> **Status note (2026-05-10):** Auth migration Phase 1 has shipped — the MCP path (claude.ai connector) is now fronted by Cloudflare Access OAuth (Spec A). The extension API still sits behind the legacy `X-Extension-Token` header until Spec B lands; new user-facing endpoints must NOT add new shared-secret headers (see `docs/security.md`). The sync worker's 15-minute cron is currently OFF (commit `b40dcac`, 2026-05-10) — the rebuild Workflows still exist and can be triggered manually via `POST /admin/full-rebuild`, but the recurring tail-sync + pipeline rebuild won't fire until the writers gate on per-row change detection. Webhook-driven cache writes are unaffected.
>
> Call-state architecture has settled on **webhook-driven Durable Object** storage. Per-user `ExtCallState` DO holds the active Dialpad `call_id` with strong consistency. The Dialpad `calling`+`hangup` webhook (`/webhook/dialpad/extension-calls`) is the only writer; `/dialpad-call`, `/dialpad-hangup`, and `/extension-call-status` are read-only.

## System Overview

Three Cloudflare Workers cooperating around a small set of D1 + KV bindings:

- **`rf-dialpad-sync-dev`** (main worker, this repo's root) — the integration hub. Receives webhooks from RecruiterFlow (RF), Dialpad, Google Calendar, Krisp, and the LinkedIn extension; writes to RF + Dialpad APIs; serves the extension and PWA routes; also serves the internal `/mcp/*` API consumed only over a service binding from the MCP worker. Owns `USERS_DB` (D1) and `SYNC_STATE` (KV) writes; reads `RF_MCP_CACHE` (D1).
- **`rf-mcp-cache-sync`** (sync worker, `sync-worker/` subtree) — the **sole writer** of `RF_MCP_CACHE` (D1). Runs a 15-min tail sync (currently disabled) and two on-demand Workflows: `FullRebuildWorkflow` for full repopulation and `PipelineRebuildWorkflow` for per-job pipeline refreshes. Triggered manually via `POST /admin/full-rebuild` on its own URL.
- **`rf-mcp-remote`** (MCP worker, `mcp-worker/` subtree) — the public Streamable-HTTP MCP server consumed by claude.ai. Stateless TypeScript Worker; validates the Cloudflare Access JWT, then service-binds into the main worker's `/mcp/*` surface. Owns no storage; never reads RF directly.

RF is the source of truth for candidate records. The KV `SYNC_STATE` cache provides fast lookups for integrations that don't have an RF candidate ID, and short-TTL snapshot caches make the extension's sidepanel responsive when recruiters walk through bulk-added candidate queues.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ RecruiterFlow │ │   Dialpad    │  │  Dialpad     │  │   Google     │  │    Krisp     │  │   LinkedIn   │
│   (RF)       │  │  (contacts)  │  │  (calls)     │  │  Calendar    │  │              │  │  Extension   │
│              │  │              │  │              │  │  + Reclaim   │  │              │  │ (Chrome) +   │
│              │  │              │  │              │  │              │  │              │  │ Mobile PWA   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ webhook         │ webhook         │ webhook         │ Apps Script      │ webhook         │ POST (X-Extension-Token)
       ▼                 ▼                 ▼                 ▼                  ▼                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                          Cloudflare Worker: rf-dialpad-sync-dev (main worker)                             │
│                                                                                                            │
│  Public webhook routes  + extension/PWA routes (X-Extension-Token)                                        │
│                                                                                                            │
│  Internal /mcp/* routes (NOT public — service-binding-only from rf-mcp-remote)                           │
│                                                                                                            │
│  Bindings:                                                                                                 │
│    KV  SYNC_STATE       — debounce flags + candidate/index cache + ratelimit + extension caches          │
│    D1  USERS_DB         — team registry (writes via migrations; reads via src/users.js, async cache)     │
│    D1  RF_MCP_CACHE     — candidates/jobs/pipelines cache (READ-ONLY here; sync worker writes)           │
│    DO  EXT_CALL_STATE   — per-user active Dialpad call_id (ExtCallState class, idFromName(dialpadId))   │
│    AI  Workers AI       — cold-call classifier (Llama 3.3 70B) + summary extractor (Llama 3.1 8B)       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                ▲                                                                          │
                │ service binding                                                          │ wrangler d1 execute / deploy refresh
   ┌────────────┴─────────────────┐                                              ┌─────────▼──────────────┐
   │  Cloudflare Worker:           │                                             │ Cloudflare Worker:      │
   │  rf-mcp-remote (mcp-worker/)  │                                             │ rf-mcp-cache-sync       │
   │                               │                                             │ (sync-worker/)          │
   │  POST /mcp                    │                                             │                         │
   │   ↓ verifyAccessJwt           │                                             │ POST /admin/full-rebuild│
   │   ↓ MIDDLEWARE.fetch(/mcp/*)  │                                             │ scheduled() — cron OFF  │
   │  GET /health                  │                                             │                         │
   │                               │                                             │ Workflows:              │
   │  Bindings:                    │                                             │   FullRebuildWorkflow   │
   │    Service: MIDDLEWARE        │                                             │   PipelineRebuildWflw   │
   │    Vars: ACCESS_TEAM_DOMAIN   │                                             │ Bindings:               │
   │    Secret: ACCESS_AUD_MCP     │                                             │   D1: RF_MCP_CACHE      │
   │                               │                                             │   KV: SYNC_STATE        │
   │  ↓ Authorization: Bearer JWT  │                                             │   Workflow bindings     │
   └─────────────▲─────────────────┘                                             └──────────────────────┬──┘
                 │                                                                                       │
                 │ DCR + OAuth (PKCE/S256)                                                              │ writes
            ┌────┴──────────┐                                                                            │ candidates,
            │ claude.ai     │                                                                            │ candidate_jobs,
            │ MCP connector │                                                                            │ jobs,
            └───────────────┘                                                                            │ job_pipelines,
                                                                                                          │ sync_state
                                                                                                          ▼
                                                                                                    RF_MCP_CACHE
                                                                                                    (D1, shared
                                                                                                     read-only with
                                                                                                     main worker)

┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Identity: Cloudflare Access (Zero Trust Free, team example-team.cloudflareaccess.com)                  │
│  - App "rf-mcp-remote" — Managed OAuth + DCR + redirect https://claude.ai/api/mcp/auth_callback          │
│    AUD lives in env.ACCESS_AUD_MCP (rf-mcp-remote secret)                                                 │
│  - App for extension API — pending (Spec B)                                                              │
│  - Login: Email OTP. Reusable policy `rf-team` (Allow if email ends @<your-team-domain>)                 │
│  → Full auth detail in docs/security.md                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Security

All user-facing endpoints (browser, AI client, extension) are converging on Cloudflare Access OAuth — App 1 (`rf-mcp-remote`) is live; App 2 (extension API) is pending Spec B. Webhook endpoints keep their existing per-source signed-token auth. Service-binding traffic between workers is implicitly trusted within the account boundary; the upstream worker validates the JWT once and forwards a body field with the verified identity.

**Read [`docs/security.md`](security.md)** before adding/touching any user-accessible endpoint, header, or anything tied to identity. That doc is canonical for: provider config (team domain, OTP login, reusable `rf-team` policy), application registrations, the JWT validation helper API (`verifyAccessJwt` — same shape in `src/access-auth.js` and `mcp-worker/src/access-auth.ts`), env vars (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD_MCP`, future `ACCESS_AUD_MIDDLEWARE`), and the identity flow end-to-end.

This file does NOT duplicate that material. References below use the Access auth model as a given.

---

## Source Files

### Main worker (`rf-dialpad-sync-dev`)

| File | Purpose |
|------|---------|
| `src/index.js` | Worker entry point: the request router (`fetch`), the hourly stage-stats reconcile cron (`scheduled`), the OTel/LaunchDarkly instrumentation wiring, and the Durable Object re-exports (`ExtCallState`, `ColdCallArbiter`) so wrangler picks them up. All route handlers live in `src/handlers/`. |
| `src/handlers/` | Route handlers, grouped by domain: `rf-webhooks.js` (RF create/update + manual re-sync), `dialpad-webhooks.js` (contact updates, call events, the extension-calls DO writer), `calendar-webhook.js`, `dialpad-sync.js` (the shared RF → Dialpad contact-sync helper), `krisp-webhook.js`, `apollo-enrichment.js` (webhook + merge/apply), `cold-call-routes.js` (arbiter finalize callback + test harness), `candidates.js` (extension add / add-to-job / mark-invalid / details + neighbor-prewarm), `dialpad-endpoints.js` (user context, call, SMS, hangup, call-state poll), `pipeline-endpoints.js` (sourcing jobs, job pipeline, call stats). |
| `src/users.js` | Team registry — D1-backed (`USERS_DB`), async, env-first. Public lookups `getUserByEmail`, `getUserByFirstName`, `getUserByDialpadId`, `getUserByRFUserId`, `resolveRFUserId`, `getRFUserIdByDialpadId`, `isMonitoredDialpadUser` (all async, take `env` first). Module-level cache populated on first call after Worker boot via a single bulk SELECT; refreshed only on Worker restart. **Source of truth for cold-call attribution, calendar owner-only logic, extension `consultantFirstName` resolution, and MCP `consultantEmail` resolution.** Adding a teammate = new `migrations/` SQL applied via `wrangler d1 execute --remote` + Worker redeploy. |
| `src/access-auth.js` | `verifyAccessJwt(request, env, expectedAud)` — Cloudflare Access JWT validation. RS256-locked, Cf-Access-Jwt-Assertion header preferred (Authorization: Bearer fallback), JWKS via jose's `createRemoteJWKSet`. Returns `{ email (lowercased), sub }` or `null`. Empty-string defense on email/sub. Test-only `_setJwksForTests(jwkSet \| null)`. |
| `src/auth.js` | Dialpad webhook JWT verification (HS256 via jose). Used only for inbound Dialpad webhooks; not user-facing. |
| `src/cache.js` | KV cache: canonical records, index keys (linkedin, email, name), consultant_id per job-link, details + activities snapshots, batch index, prewarm state, invalidation helper. |
| `src/rf-client.js` | RF API client: search/get/update, LinkedIn URL validation & normalization, Dialpad↔RF data conversion, custom-field consultant_id read/write/resolve, activity-list, phone normalization (`normalizeToE164`), job disambiguation (`pickConsultantJob`), stage-move filter, prewarm helper, single-retry-on-502 in `getRFCandidate`. |
| `src/dialpad-client.js` | Dialpad API client: contact PUT (create/update), data preparation from RF candidate format, `getUserCallerId` and `initiateCall` for the LinkedIn extension calling flow, `buildCallerIdsFromDialpad` (pure transform → opaque-alias `callerIds[]`), `sendSMS` (POST `/sms` rolled-params wrapper), `hangupCall({ callId })` (PUT `/call/{id}/actions/hangup`). |
| `src/dialpad-aliases.js` | Opaque caller-ID alias signing/verifying (HS256 JWT via jose, audience `dialpad-caller-id`, 7-day TTL). Keeps raw E.164 numbers off the wire. |
| `src/rate-limit.js` | Rolling-window rate-limit + cheap dedup gate for `/dialpad-call`. Pure decision function + KV-backed `checkAndRecordCall`. 5 calls/60s rolling per Dialpad user_id, plus a 3s per-(user,phone) dedup window for double-clicks. |
| `src/krisp.js` | Krisp helpers: note formatting (HTML), candidate email extraction from meeting participants. |
| `src/cold-call.js` | Cold call detection: monitored-user filter (registry-driven), Dialpad transcript fetch, Workers AI classification (Llama 3.3 70B), per-outcome summary extraction (Llama 3.1 8B), RF custom activity + tag/source update + Sourced→Replied stage move, generic `mergeTag(tags, value)` helper, `parseColdCallActivity` for the extension shape. |
| `src/extension-calls.js` | Extension Call/Hangup webhook dispatcher. `processExtensionCallEvent` filters Dialpad webhook payloads (outbound + monitored target), routes `calling`/`hangup` events to the per-user `ExtCallState` DO. |
| `src/extension-call-do.js` | `ExtCallState` Durable Object class. Per-user store, one instance per Dialpad user (`idFromName(dialpadUserId)`). RPC: `setCallId`, `getCallId`, `clearCallIdIfMatch`. 20-min self-clearing alarm on `setCallId`. |
| `src/apollo-client.js` | Apollo API client: enrichment, search, verification, scoring. |
| `src/enrichment.js` | Enrichment orchestration: ownership check (sourced from `users.js`), LinkedIn verify, fallback search, phone reveal. |
| `src/mcp/router.js` | `/mcp/*` dispatcher. Resolves consultant from body field — prefers verified `consultantEmail` (forwarded by `rf-mcp-remote` from the Access JWT); transitional `consultantFirstName` fallback for legacy callers (logs `[mcp] legacy consultantFirstName fallback`, drops when Spec B Phase 3 lands). No header auth — only callable over the service binding. |
| `src/mcp/{cache-status,candidate-get,candidate-search,candidate-move-stage,candidate-log-interview,job-pipeline,job-candidates-filter}.js` | Per-tool middleware handlers. |
| `src/mcp/{resolvers,fuzzy,projection,linkedin,d1-read,snapshot,handlers-registry}.js` | Shared middleware infrastructure. |
| `migrations/0001_create_users.sql`, `migrations/0002_seed_users.sql` | `USERS_DB` schema + seed data (six teammates). Email PK with lowercase + LIKE-form CHECK constraints; UNIQUE indexes on `dialpad_id`, `rf_user_id`, `first_name`. |
| `scripts/calendar-sync.gs` | Google Apps Script: detects Reclaim bookings on Google Calendar, extracts candidate data, posts to worker. |
| `wrangler.jsonc` | Worker config: KV/D1/DO/AI bindings, vars, compatibility settings (no secrets — those are Cloudflare-managed). |
| `vitest.config.js` | Vitest + miniflare config; test-only secret bindings live here, not in wrangler.jsonc. |
| `test/index.spec.js`, `test/e2e.spec.js`, `test/extension-calls.spec.js`, `test/rf-client.spec.js`, `test/access-auth.spec.js`, `test/users-d1.spec.js`, `test/pwa-endpoints.spec.js`, `test/mcp-*.spec.js`, `test/helpers/{d1-migrate,users-migrate}.js` | Vitest tests using `@cloudflare/vitest-pool-workers`. |

### Sync worker (`sync-worker/`, deploys as `rf-mcp-cache-sync`)

| File | Purpose |
|------|---------|
| `sync-worker/src/sync-worker.js` | Entry. Exports `default` with `scheduled()` (cron handler — currently disabled in `wrangler.sync.jsonc`) and `fetch()` (admin-only). `tailSync(env)` is the every-15-min tail-sync core. Re-exports `FullRebuildWorkflow` and `PipelineRebuildWorkflow` so wrangler registers them. |
| `sync-worker/src/workflow.js` | `FullRebuildWorkflow` + the testable `runFullRebuild(env, step, instanceId, params)` core. Drives full repopulation (candidates page-walk, jobs, users, activity_types, custom_fields, then delegates to pipeline rebuild for every open job). Uses `step.do(name, opts, fn)` for retry semantics; an in-flight token claim/release wraps the run via try/finally. |
| `sync-worker/src/pipeline-workflow.js` | `PipelineRebuildWorkflow` + `runPipelineRebuild`. One step per open job: fetches RF `/job/pipeline`, normalizes via `normalizePipelineDetail`, writes the row via `writeJobPipeline`. Per-step retries (3 attempts, exponential backoff). |
| `sync-worker/src/d1-write.js` | Atomic D1 upsert helpers — `writeCandidatesAndLinks`, `writeJobs`, `writeJobPipeline`. Uses D1 `batch()` (single implicit transaction). Chunks at the candidate boundary; never splits one candidate's statements across two batches. **Currently does NOT gate on per-row change detection** — every tick re-INSERT-OR-REPLACEs the full set. This is why the cron is disabled (write-storm without consumers). |
| `sync-worker/src/normalize.js`, `sync-worker/src/pipeline-normalize.js` | RF payload → D1 row normalization (candidate, candidate_jobs, jobs, pipeline summary, stage_candidates). |
| `sync-worker/src/rf-list-client.js` | Sync-worker's RF API client: paginated list endpoints (`/candidate/list`, `/job/list`, `/user/list`, `/activity-type/list`, `/custom-field-schema/list`, `/job/pipeline`), tail-sync cursor logic. |
| `sync-worker/src/sync-state.js` | Read/write/delete helpers over the `sync_state` D1 table — used for `last_full_rebuild_at`, `last_tail_sync_at`, `in_flight` tokens, watchdog timestamps. |
| `sync-worker/src/users.js` | Local copy of the registry used during user enrichment work. Sync-worker-internal; does NOT replace the main worker's `users.js`. |
| `sync-worker/migrations/0001_init.sql` | `RF_MCP_CACHE` initial schema: `candidates`, `candidate_jobs`, `jobs`, `sync_state`. |
| `sync-worker/migrations/0002_job_pipelines.sql` | `RF_MCP_CACHE` `job_pipelines` table for per-job pipeline snapshots. |
| `sync-worker/wrangler.sync.jsonc` | Sync-worker config: D1 + KV bindings, Workflow bindings, RF_API_BASE_URL var. Cron block currently commented out. |
| `sync-worker/vitest.config.js` | Vitest config for sync-worker tests. |
| `sync-worker/test/{admin,d1-write,normalize,pipeline-normalize,pipeline-workflow,rf-list-client,sync-state,tail-sync,workflow}.spec.js` | Sync-worker tests. |

### MCP worker (`mcp-worker/`, deploys as `rf-mcp-remote`)

| File | Purpose |
|------|---------|
| `mcp-worker/src/index.ts` | Entry. `fetch()` validates the Access JWT against `env.ACCESS_AUD_MCP`, builds a fresh per-request `McpServer` (factory-per-request — required by MCP SDK ≥1.26.0, CVE GHSA-345p-7cg4-v4c7), dispatches via `createMcpHandler` from `agents/mcp`. `GET /health` returns `ok`; everything but `POST /mcp` returns 404. |
| `mcp-worker/src/access-auth.ts` | TypeScript twin of `src/access-auth.js`. Same public API (`verifyAccessJwt`), same RS256 lock, same empty-string defense, same lowercase email return. Exports a `_MODULE_ID` sentinel to guard against vite resolving to the main worker's JS file via relative-path fallback. |
| `mcp-worker/src/tools.ts` | `registerTools(server, ctx)` — registers the seven MCP tools (`rf_candidate_search`, `rf_candidate_get`, `rf_candidate_move_stage`, `rf_candidate_log_interview`, `rf_job_candidates_filter`, `rf_job_pipeline`, `rf_cache_status`). Each tool body calls `mwFetch` over the service binding; max-result truncation at 140k chars. |
| `mcp-worker/src/mw-client.ts` | Thin client over the `MIDDLEWARE` service binding. Hostname is conventional only (binding dispatches by binding, not DNS). Always merges `consultantEmail` (verified, from JWT) into the request body, overriding any caller-supplied value. No header-based auth — service-binding traffic is trust-local. |
| `mcp-worker/src/instructions.ts` | Server-instructions string Claude sees on session start. |
| `mcp-worker/wrangler.mcp.jsonc` | MCP-worker config: `MIDDLEWARE` service binding to `rf-dialpad-sync-dev`, `ACCESS_TEAM_DOMAIN` var, observability. `ACCESS_AUD_MCP` is a secret. |
| `mcp-worker/test/{access-auth,auth,tool-dispatch}.spec.ts`, `mcp-worker/test/jwt-fixture.ts`, `mcp-worker/test/env.d.ts` | TypeScript tests with a shared RSA-keypair JWT fixture. |
| `mcp-worker/vitest.config.ts` | Vitest config; injects `ACCESS_TEAM_DOMAIN` and a fixture-derived `ACCESS_AUD_MCP` into the test env. |

### Observability libs (all workers)

| File | Purpose |
|------|---------|
| `src/lib/*.js`, `sync-worker/src/lib/*.js`, `mcp-worker/src/lib/*.ts`, `metrics-poller/src/lib/*.ts` | OTel helpers — `flow-names`, `otel-config`, `body-capture`, `logs-bridge`, `ld-resource-injector`, plus per-worker additions (`ai-instrument`, `trace-link`, `instrumented-step`, `bootstrap-otel`). Byte-identical copies across workers with closed-set drift tests. See `docs/observability.md`. |
| `metrics-poller/` | Separate worker `rf-cf-metrics-poller`. Hourly cron pulls D1 / KV / AI metrics from Cloudflare GraphQL Analytics, pushes OTel metric records to LaunchDarkly's `/v1/metrics`. See `docs/observability.md`. |
| `vendor/otel-cf-workers/` | Forked + patched `@microlabs/otel-cf-workers` v1.0.0-rc.52 (npm workspace). Carries a 5-line patch to `BatchTraceSpanProcessor.exportSpans()` that invokes the `postProcessor` callback (without it, `launchdarkly.project_id` resource attribute injection silently doesn't reach LD). See `vendor/otel-cf-workers/VENDOR.md`. |

---

## Observability

Every worker emits OTel traces + logs to LaunchDarkly Observability. The pipeline (architecture, helpers, kill switches, dashboards, alert wiring, PII trade-off rationale) is documented in `docs/observability.md`; alert runbooks at `docs/observability-runbooks.md`. The four workers each have their own `lib/` directory of byte-identical helpers (`flow-names`, `otel-config`, `body-capture`, `logs-bridge`, `ld-resource-injector`, plus per-worker additions). A separate `metrics-poller/` worker polls Cloudflare GraphQL Analytics hourly and pushes OTel metrics to LD. Cloudflare native observability stays enabled at `head_sampling_rate: 0.1` on every worker as an always-on no-cost fallback.

---

## Endpoints

### Public routes — main worker (`rf-dialpad-sync-dev`)

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/health` | GET | None | Health check |
| `/webhook/recruiterflow` | POST | `X-RF-Webhook-Token` header | RF candidate Created/Updated events |
| `/webhook/recruiterflow/manual` | POST | `?token=` query param (`RF_WEBHOOK_SECRET`) | Manual RF candidate sync (flat payload) |
| `/webhook/dialpad` | POST | JWT Bearer (HS256) | Dialpad contact Updated events |
| `/webhook/calendar` | POST | `X-Calendar-Webhook-Token` header | Calendar booking events (from Apps Script) |
| `/webhook/krisp` | POST | `X-Krisp-Webhook-Token` header | Krisp meeting note webhooks |
| `/webhook/dialpad/calls` | POST | JWT Bearer (HS256) | Dialpad call transcription/voicemail webhooks |
| `/webhook/dialpad/extension-calls` | POST | JWT Bearer (HS256) | Dialpad call-state (`calling`/`hangup`) webhook driving the extension button |
| `/webhook/apollo` | POST | `?token=` query param (`APOLLO_WEBHOOK_SECRET`) | Async phone reveal delivery from Apollo |
| `/candidates` | POST | `X-Extension-Token` header | LinkedIn extension batch upsert (sets `lead_owner_id`) |
| `/candidates/add-to-job` | POST | `X-Extension-Token` header | Add candidates to a job + write `consultant_id` custom field |
| `/candidate-details` | POST | `X-Extension-Token` header | Sidepanel data: rfId, phone (E.164), picked job, cold-call activities |
| `/candidate-mark-invalid` | POST | `X-Extension-Token` header | Tag candidate `"Number Invalid"` (idempotent) |
| `/dialpad-user-context` | POST | `X-Extension-Token` header | Caller-ID picker data (opaque aliases, no raw E.164) |
| `/dialpad-call` | POST | `X-Extension-Token` header | Initiate call via Dialpad `initiate_call` |
| `/dialpad-sms` | POST | `X-Extension-Token` header | Send a single SMS via Dialpad `/sms` |
| `/dialpad-hangup` | POST | `X-Extension-Token` header | Terminate the consultant's active call |
| `/extension-call-status` | POST | `X-Extension-Token` header | Polled ~every 500ms by extension after a `/dialpad-call` |
| `/my-sourcing-jobs` | POST | `X-Extension-Token` header | Mobile PWA home screen — open Sourcing-status jobs the consultant is on |
| `/job-pipeline` | POST | `X-Extension-Token` header | Mobile PWA pipeline view — Sourced-stage candidates for a job |

> **Auth migration in flight (Spec B):** the `X-Extension-Token` + `consultantFirstName`-in-body shape on the extension routes is being replaced by Cloudflare Access OAuth + `consultantEmail` from the verified JWT. Same rules apply to any new user-facing endpoint added during the migration — see `docs/security.md`.

### Service-binding-only routes — main worker

These land on `rf-dialpad-sync-dev` but are NOT publicly addressable. They're called only via the `MIDDLEWARE` service binding from the MCP worker (`rf-mcp-remote`), which is itself behind Cloudflare Access. Auth is "service-binding origin is trusted within the Cloudflare account boundary"; identity arrives as a `consultantEmail` body field, derived from a JWT verified upstream.

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/mcp/cache-status` | POST | service binding (trusted) — `consultantEmail` body | Sync-state stamps + table counts; cheap health probe |
| `/mcp/candidate-search` | POST | service binding (trusted) — `consultantEmail` body | Filter (D1 SELECT) and/or fuzzy (in-memory snapshot) candidate search |
| `/mcp/candidate-get` | POST | service binding (trusted) — `consultantEmail` body | Single candidate by id or fuzzy query (auto-disambiguates) |
| `/mcp/candidate-move-stage` | POST | service binding (trusted) — `consultantEmail` body | RF `/candidate/move-to-stage` — fuzzy-resolves candidate/job/stage |
| `/mcp/candidate-log-interview` | POST | service binding (trusted) — `consultantEmail` body | RF custom-activity (Interview); returns `outlook_url` / `gcal_hint` for calendar handoff |
| `/mcp/job-candidates-filter` | POST | service binding (trusted) — `consultantEmail` body | Flat list of active candidates on a job |
| `/mcp/job-pipeline` | POST | service binding (trusted) — `consultantEmail` body | Per-job pipeline view, candidates grouped by stage |

> A transitional `consultantFirstName` body fallback is honoured by the router for legacy callers (logs `[mcp] legacy consultantFirstName fallback`); it disappears when Spec B Phase 3 lands. New endpoints should not rely on it.

Full middleware semantics (resolvers, ID short-circuit, default fields, recovery envelopes) are documented in [`docs/mcp-middleware.md`](mcp-middleware.md).

### Public routes — MCP worker (`rf-mcp-remote`)

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/mcp` | POST | Cloudflare Access JWT (RS256, `aud === ACCESS_AUD_MCP`) | Streamable-HTTP MCP — DCR + tool calls |
| `/health` | GET | None | Health check (`ok`) |

The MCP worker validates the JWT, builds a fresh per-request `McpServer` (mandatory for MCP SDK ≥1.26.0), then `createMcpHandler` from `agents/mcp` dispatches the tool call. Every tool body calls `mwFetch` over the service binding into the corresponding `/mcp/*` route on the main worker.

### Sync worker (`rf-mcp-cache-sync`) routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/admin/full-rebuild?only=<candidates\|jobs\|pipelines\|null>` | POST | `X-Admin-Token` (`ADMIN_SECRET`, timing-safe) | Kicks off `FullRebuildWorkflow`. Returns `{ ok, workflow_id }`. |

Cron is currently disabled (see "Sync worker" below). The 15-min `scheduled()` handler runs both the tail-sync and `PipelineRebuildWorkflow` when active.

---

## Data Flow: RF → Dialpad

**Trigger**: RF fires webhook when a candidate is created or updated.

```
RF webhook (Created/Updated)
  → POST /webhook/recruiterflow
  → Verify X-RF-Webhook-Token (fail closed)
  → Parse candidate from payload
  → Validate: must have name + organization + title
  → Create/update Dialpad contact (PUT /contacts with UID=RF{id})
  → Set debounce: sync:RF{id} = "true" (60s TTL)
  → Cache candidate (canonical record + all index keys)
```

**Validation rules**: Candidates without name (first+last or combined `name` field), organization, or title are silently skipped. These fields are required by Dialpad for useful contact records.

**ID mapping**: RF candidate ID `12345` → Dialpad UID `RF12345` → Full Dialpad contact ID `shared_contact_pool_Company:0000000000000000_uid_RF12345`.

---

## Data Flow: Dialpad → RF

**Trigger**: Dialpad fires JWT-signed webhook when a contact is updated. "Created" events are ignored (they're just echoes of RF→Dialpad sync).

```
Dialpad webhook (Updated only)
  → POST /webhook/dialpad
  → Verify JWT (HS256) from Authorization header or raw body
  → Extract RF candidate ID from Dialpad contact ID (regex: /uid_RF(\d+)$/)
  → Check debounce: if sync:RF{id} exists → skip (RF just synced this)
  → Convert Dialpad data to RF format (email, phone, LinkedIn only)
  → POST /candidate/update to RF
  → Set debounce: sync:RF{id} = "true" (60s TTL)
  → Update cache: merge Dialpad changes into cached record
    (cache miss → fetch fresh from RF API and cache)
```

**Sync scope**: Only email, phone, and LinkedIn URL flow from Dialpad → RF. Name, organization, title, and other fields are RF-managed.

---

## Data Flow: Calendar → RF + Dialpad

**Trigger**: Google Apps Script detects a Reclaim booking event on Google Calendar (via EventUpdated trigger, runs every invocation scanning next 14 days).

### Booking Types

The worker handles two booking types:

1. **Dialpad meeting link** - event location contains `"meetings.dialpad.com/"`
   - Merges attendee email into candidate's email array
2. **Phone Call** - event location contains `"Phone Call"`
   - Merges attendee phone number into candidate's phone array
   - Merges attendee email into candidate's email array

### Apps Script Filtering (3-signal combo)

All three must be present for an event to be processed:
1. Description contains `"Looking forward to meeting!"` (custom Reclaim booking phrase)
2. Description contains `"Question: LinkedIn Profile"` (pre-meeting question)
3. Location contains either `"meetings.dialpad.com/"` (Dialpad meeting link) or `"Phone Call"`

Plus: exactly 1 non-owner guest (the candidate).

### Worker Processing

```
Apps Script → POST /webhook/calendar
  → Verify X-Calendar-Webhook-Token (fail closed)
  → Validate: attendee_email required

  → Find RF candidate (three-tier lookup):
      Tier 1: LinkedIn cache lookup (if valid LinkedIn URL)
      Tier 2: RF search API (fallback on cache miss, warms cache)
      Tier 3: Email cache lookup (if no candidateId yet)
      Tier 4: Name cache lookup (unambiguous matches only)

  → GET /candidate/get?id=X (fetch current data — RF update REPLACES, not appends)

  → For Dialpad meeting link bookings:
      - Check if email already exists on candidate → skip if yes
      - Merge new email into existing array (first email gets is_primary=1)

  → For Phone Call bookings:
      - Extract phone number from event
      - Check if phone already exists on candidate → skip if yes
      - Merge new phone into existing array
      - Merge new email into existing array

  → POST /candidate/update with merged data
  → Set debounce: sync:RF{id} = "true" (60s TTL)
  → Upsert Dialpad contact directly (don't wait for RF webhook — 6-7 hour delay)

  → Check if candidate is eligible for stage movement:
      - Current stage is Sourced, Replied, or Replied (Cold)
      - Find most-recently-moved job on candidate
      - If eligible job found → POST /api/external/candidate/move-to-stage (move to "Call Booked")

  → Update candidate cache with new email/phone data
```

**Stage Movement**: After successful email/phone merge and RF update, the worker calls `findEligibleJob()` (in `rf-client.js`) to check if the candidate can be moved to "Call Booked". The job must:
- Have current stage in: Sourced, Replied, or Replied (Cold)
- Be the most-recently-moved job on the candidate

If eligible, `moveToCallBooked()` calls `POST /api/external/candidate/move-to-stage` with the stage ID.

> **Stage-move helpers in `rf-client.js`** — there are two pairs:
> - `findEligibleJob` / `moveToCallBooked` — calendar-booking flow only. Hardcoded to "Call Booked" target and the most-recently-moved-job heuristic.
> - `findJobsForStageMove` / `moveJobsToStage` — generalised pair (parameterised by `currentStage`, `targetStage`, optional `addedByUserId`, optional `openOnly`). Used by the cold-call Sourced→Replied flow; reusable for future stage transitions without touching the calendar pair.

---

## Data Flow: Krisp → RF

**Trigger**: Krisp fires `summary_generated` webhook after a meeting ends and the AI summary is ready.

```
Krisp webhook (summary_generated)
  → POST /webhook/krisp
  → Verify X-Krisp-Webhook-Token (fail closed)
  → Check KV dedup: krisp:note:{hash} — skip if already processed (24-hour TTL)
  → Extract non-Joel email from meeting participants
  → Find RF candidate (two-tier lookup):
      Tier 1: Email cache lookup
      Tier 2: RF search API (by email)
  → Format meeting content as HTML note (summary, action items, key points, etc.)
  → POST /candidate/notes/add to RF
  → Set dedup flag: krisp:note:{hash} = "true" (24-hour TTL)
```

**Scope**: One-way, read-only integration. Krisp data flows to RF as candidate notes only. No data flows back to Krisp, no Dialpad sync triggered, no cache updates needed.

**Dedup**: Uses a hash of meeting ID + candidate email to generate the KV dedup key. The 24-hour TTL prevents reprocessing if Krisp retries the webhook.

---

## Data Flow: Dialpad Calls → RF (Cold Call Detection)

**Trigger**: Dialpad fires `call_transcription` or `transcription` (voicemail) webhook event after a call ends and the transcript is ready. Cold-call contacts are always pre-linked via the LinkedIn extension, so the call payload arrives with an RF candidate UID embedded in `contact.id`.

```
Dialpad call event (call_transcription or transcription state)
  → POST /webhook/dialpad/calls
  → Verify JWT (HS256, DIALPAD_WEBHOOK_SECRET)

  → Pre-LLM filters (cheap, fail-fast, exit before any KV / Dialpad / AI call):
      - target.id must be in USERS_DB (registry-driven via isMonitoredDialpadUser)
      - direction must be "outbound"
      - contact.id must contain an RF UID (uid_RF regex, String() coerced)

  → Set KV dedup: coldcall:{call_id} = "true" (5-min TTL) BEFORE transcript fetch
  → Get transcript:
      - transcription state: transcription_text from payload (voicemails)
      - call_transcription state: GET /api/v2/transcripts/{call_id}
  → Truncate to 5,000 chars
  → Classify via CF Workers AI (Llama 3.3 70B fp8 fast)
  → If not cold call → log + done

  → Cold call detected:
      1. GET /candidate/get?id=X — required because RF /candidate/update REPLACES
         array fields (including tags), so we must read existing tags before
         writing the merged set back. Logs raw `existingTags` for shape verification.
      2. Build activity_text = "Cold call with {contactName} — {outcomeLabel}"
         For connected_positive: append "\n\nNext steps:\n{bullets}" (Llama 3.1 8B,
           1500-char transcript tail, ACTION_ITEMS_PROMPT).
         For connected_negative: append "\n\nNotes:\n{bullets}" (same model + tail,
           NEGATIVE_NOTES_PROMPT focused on the candidate's situation/intent —
           explicit "each bullet on its own line" directive).
      3. addHtmlLineBreaks(activity_text): "\n" → "<br>\n". RF activity_text only
         honours <br>; bare \n collapses to a space at render time.
      4. POST /custom-activity/create (activity_type_id=1002,
         activity_user_id resolved via getRFUserIdByDialpadId(env, target.id))
      5. POST /candidate/update with single combined body
         { source: "Cold Call", tags: [...existingTags, "Cold Called"] }
         (de-duped on "Cold Called", defensive against missing/non-array tags field)

  → For connected_positive OR connected_negative outcomes (NOT voicemail):
      6. moveJobsToStage(candidateId, candidate, {
            currentStage: 'Sourced',
            targetStage: 'Replied',
            userId: activityUserId,
            recruiterRfUserId: activityUserId,   // filter via cached consultant_id
         }, env)
         → findJobsForStageMove walks candidate.jobs, builds the eligible set
           (open + stage_name === 'Sourced' + has 'Replied' stage). For each
           eligible job it resolves the consultant_id via resolveJobConsultantId
           (KV `consultant:job{jobId}:cand{rfId}` first, RF GET on miss).
         → Returns the FIRST job whose consultant_id matches the recruiter.
         → Falls back to jobs[0] if eligible when no match — preserves legacy
           behavior for older job-candidate links that lack the custom field.
         → For the matched (or fallback) job, POST /candidate/move-to-stage with
           user_id = recruiter.
```

### Key design decisions

**LLM Classification**: No keyword matching. System prompt describes cold call characteristics conceptually — first contact, introducing yourself, unfamiliar tone, plus DEFINITE indicators ("headhunter", LinkedIn-message references). Model returns JSON with `is_cold_call` + outcome (`voicemail` / `connected_positive` / `connected_negative`) + reasoning. Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI binding. Workers AI may return the response as an already-parsed object or a JSON string — code handles both.

**Per-outcome enrichment**: connected_positive and connected_negative each get a separate cheap-model pass over the trailing 1500 chars of transcript. Positive uses ACTION_ITEMS_PROMPT (commitments, follow-up method, next steps); negative uses NEGATIVE_NOTES_PROMPT (general candidate context — situation, plans, timing, perspective). Bullet character is left to the model; the negative prompt additionally enforces "each bullet on its own line" so the `<br>` transform reliably breaks up the rendered output.

**Tag handling**: The "Cold Called" tag is written via the same `/candidate/update` call as `source`. `updateRFCandidate` uses spread (`{ id, ...updateData }`) so `tags` is only present when the caller passes it — other update paths (Dialpad→RF, calendar) leave existing tags untouched. The cold-call flow is the only writer of tags currently.

**Stage move attribution**: `addedByUserId` is the *filter* (only progress jobs the calling recruiter sourced), and `userId` is the *actor* (who RF records as performing the move). Both come from the registry lookup keyed by Dialpad target.id, so each recruiter's stage moves attribute to their own RF user.

**Synchronous, fail-fast, no retries**: The whole cold-call write chain (activity → tag/source → stage move) runs synchronously. Any failure aborts and surfaces via CF Logs; we'd rather lose an event than risk silent partial state, duplicate activities, or wiped tags. Volume is low enough (~100 calls/day) that manual fix-ups are tractable.

**Dedup before AI**: The dedup flag is set immediately after the dedup check, before transcript fetch or AI classification. This prevents Dialpad retry storms from re-hitting Workers AI on failures. If a step fails after dedup is set, the call won't be retried until the 5-min TTL expires.

**Scope**: Driven entirely by `USERS_DB`. The Dialpad webhook subscription is configured org-wide (no `target_id` filter), so adding a new recruiter is just a `migrations/` SQL edit applied to D1 (and a Worker redeploy to refresh the cached registry) — there is no Dialpad-side per-user subscription step.

**Numeric IDs**: Dialpad sends `target.id` and `contact.id` as numbers in call webhooks. `isMonitoredDialpadUser()`, `getRFUserIdByDialpadId()`, and `extractRFIdFromDialpadContact()` all use `String()` coercion.

**Neuron budget**: ~35-40 neurons for classification + an additional ~5-10 for the cheap-model summary on connected calls. Dedup-before-AI ensures each call only hits AI once regardless of Dialpad retries.

---

## Data Flow: LinkedIn Extension → RF + Dialpad

**Trigger**: A custom Chrome extension overlaying LinkedIn Recruiter. Recruiters bulk-add candidates from a pipeline view, then walk through them one-by-one in LinkedIn opening the sidepanel for each profile to cold-call via Dialpad. Authed via `X-Extension-Token` header.

Every request body includes `consultantFirstName: string`, resolved through `src/users.js:resolveRFUserId` (async) to an RF user ID for attribution.

> **Auth model is mid-rework (Spec B).** The `X-Extension-Token` + `consultantFirstName`-in-body shape will be replaced with Cloudflare Access OAuth + `consultantEmail` from the verified JWT. The MCP path already shipped this transition (Spec A, 2026-05-10). See [`docs/security.md`](security.md) for the convention all new user-facing endpoints must follow.

### `POST /candidates` — batch upsert

```
Extension → POST /candidates (consultantFirstName, candidates[])
  → Verify X-Extension-Token (fail closed)
  → resolveRFUserId(env, consultantFirstName) → consultantRfUserId | null

  → For each candidate (chunks of 5, parallel):
      → searchRFCandidateByLinkedIn(linkedinUrl) — slug-filtered for true matches
      → Reconcile linkedin cache against RF (self-heals stale linkedin → rfId)

      If existing → processExistingRFCandidate (no lead_owner_id touched):
          → GET Dialpad contact
          → If missing: full Dialpad creation; if present: PATCH company/title only
          → Apollo phone reveal if no Dialpad phone + linkedin URL + no prior attempt

      If new:
          → mapExtensionToRFCandidate(ext, consultantRfUserId)
              — sets lead_owner_id from registry when consultantRfUserId is a number
          → POST /candidate/add (recover from 409 by re-routing to existing path)
          → Build slim candidate record from extension data (no GET round-trip needed —
            new candidates have no email/phone yet)
          → syncCandidateToDialpad → cacheCandidate
          → Apollo phone reveal (LinkedIn URL → enrichPerson, request reveal with
            run_waterfall_phone, write apollo_enrich:{rfId} flag, 15-min TTL)

  → listOpenJobs → response includes { total, created, updated, skipped, errors,
                                       results, jobs }
```

### `POST /candidates/add-to-job` — add to job + write consultant_id

```
Extension → POST /candidates/add-to-job (consultantFirstName, rfIds[], jobId)
  → Verify X-Extension-Token
  → resolveRFUserId(env, consultantFirstName) → consultantRfUserId | null

  → Per row (parallel):
      Step 1: addCandidateToJob(rfId, jobId, env)
          → 502 retry up to 3 attempts
          → Recognizes "already in pipeline" error → status: 'already_in_job'
          → Defensive null-guard: if loop exits without addResult, treat as error

      Step 2: only when status ∈ {'added', 'already_in_job'} AND consultantRfUserId !== null
          → setJobCandidateConsultantId(rfId, jobId, consultantRfUserId, env)
              POST /job-candidate/custom-field/value/update
              { candidate_id, job_id, custom_fields: [{ id: 16, value: rfUserId }] }
          → cacheConsultantForJobLink(rfId, jobId, rfUserId, env)
          → On failure: addResult.consultantWriteFailed = true (non-fatal)

      Append: appendToJobBatchIndex(jobId, rfId, env) — idempotent dedupe

  → Response: { jobId, added, alreadyInJob, errors, results }
```

Re-adds (status=`already_in_job`) DO write consultant_id and DO append to the batch index. This is intentional: the extension is the only path hitting this route, recruiters only re-add candidates they're now driving themselves, and re-adding is the user-facing way to refresh the cache + reattribute attribution for older job-candidate links.

### `POST /candidate-details` — sidepanel data

```
Extension → POST /candidate-details (consultantFirstName, profileUrl)
  → Verify X-Extension-Token
  → Resolve rfId:
      → lookupByLinkedIn (KV linkedin:{slug}) — fast path
      → searchRFCandidateByLinkedIn fallback (caches the result on hit)
      → 404 if neither yields a match

  → Try cache first (parallel):
      → getCachedCandidateDetails(rfId) (KV details:{rfId}, 20-min TTL)
      → getCachedCandidateActivities(rfId) (KV activities:{rfId}, 20-min TTL)

  → Cache MISS branches:
      → Parallel-fetch only the missing pieces:
          getRFCandidate(rfId) and/or listCandidateActivities(rfId)
      → Cache the freshly-fetched pieces

  → pickConsultantJob(candidate, consultantRfUserId, env):
      → Filter to open jobs, sort by stage_moved desc
      → For each, resolveJobConsultantId (KV → RF fallback, per-job try/catch)
      → Return first match against consultantRfUserId, else jobs[0] if open

  → normalizeToE164(first phone_number entry) → E.164 string or null

  → activities.filter(type.id === 1002).map(parseColdCallActivity).sort(asc time)

  → Fire-and-forget: ctx.waitUntil(handleNeighborPrewarm(rfId, jobId, recruiterRfId, env))

  → Response: { rfId, fullName, phoneNumber, job, activities }
```

### `POST /candidate-mark-invalid` — tag-only invalidation

```
Extension → POST /candidate-mark-invalid (consultantFirstName, rfId)
  → Verify X-Extension-Token
  → 400 if rfId missing
  → getRFCandidate(rfId) — read existing tags
  → If tags already includes "Number Invalid" → { ok: true } (no RF write)
  → Else: mergeTag(existingTags, "Number Invalid") → updateRFCandidate(rfId, { tags: merged })
  → invalidateCandidateDetailsCache(rfId) — drops details:{rfId} + activities:{rfId}
  → Response: { ok: true }
```

Phone is left in place. No custom activity is written. consultantFirstName is logged for traceability but doesn't drive any attribution write (RF tag updates don't carry per-action attribution).

### `POST /dialpad-user-context` — caller-ID picker data

```
Extension → POST /dialpad-user-context (consultantFirstName)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(env, name)
  → 403 ok=false if not in the registry
  → GET https://dialpad.com/api/v2/users/{user.dialpadId}/caller_id
  → 502 ok=false if Dialpad fetch fails (upstream details in CF Logs only)
  → buildCallerIdsFromDialpad(response, signCallerIdAlias):
      - Walk: phone_numbers ("My number"), groups[] (display_name)
      - office_main_line is intentionally skipped — never used in practice
      - De-dupe by E.164 (first occurrence wins for label)
      - Skip empty / non-E.164 entries silently
      - Mark isDefault=true on the entry whose number === response.caller_id
      - Country: +44 → UK, +1 → US, anything else → OTHER
      - Replace each E.164 with an opaque alias via signCallerIdAlias()
  → Response: { callerIds: [{ aliasId, country, label, isDefault? }] }
```

The response body never contains a raw phone number. The extension caches the response locally (TTL ~1h, keyed by consultant) and uses the aliases verbatim on `/dialpad-call`.

### `POST /dialpad-call` — initiate a call

```
Extension → POST /dialpad-call (consultantFirstName, phoneNumber, callerAliasId)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(env, name)
  → 403 ok=false if not in the registry
  → 400 ok=false if phoneNumber missing or non-E.164
  → 400 ok=false if callerAliasId missing
  → verifyCallerIdAlias(callerAliasId) → outboundCallerId (E.164)
  → 400 ok=false ("Invalid caller-ID selection — please refresh and try again") if alias is tampered/expired/unknown
  → checkAndRecordCall({ dialpadUserId: user.dialpadId, phoneNumber }) — rolling-window gate
       - Reads ratelimit:call:{dialpadUserId} (JSON [{t,phone}]) from SYNC_STATE
       - Drops entries older than 60s
       - If any entry within last 3s has same phoneNumber → 429 reason=duplicate
       - Else if recent count >= 5 → 429 reason=rate_limit
       - Else: append {t: now, phone}, write back (TTL 120s), allow
  → 429 ok=false (reason: "rate_limit" | "duplicate", retryAfterSec, Retry-After header) if blocked

  → POST https://dialpad.com/api/v2/users/{user.dialpadId}/initiate_call
       body: { phone_number, outbound_caller_id }   (NO device_id — Dialpad auto-rings)
  → 502 ok=false ("Dialpad rejected the call: <upstream message>") if non-2xx
  → Response: { ok: true }   ← worker holds the call_id; extension never sees it
```

The rate-limit + dedup is intentionally per-Dialpad-user (i.e. per recruiter), not per-candidate or per-call-id, because Dialpad's own 5/min cap is per outbound user. Mirroring it locally turns "Dialpad silently rejected this" into a clean 429 with a `retryAfterSec` the extension can render directly. Denied attempts deliberately don't consume budget — only allowed calls write back to KV. The read-decide-write isn't transactional; in the worst case two near-simultaneous edge requests both pass through, which Dialpad would reject anyway.

The worker does **not** write call-state from this endpoint. The Dialpad `calling` webhook is the single writer of the active-call store (see `/webhook/dialpad/extension-calls` below). So `/dialpad-call` is purely "ask Dialpad to ring the consultant's phone"; everything else flows from the resulting webhooks.

### `POST /dialpad-sms` — send an SMS

```
Extension → POST /dialpad-sms (consultantFirstName, phoneNumber, callerAliasId?, text)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(env, name)
  → 403 ok=false if not in the registry
  → 400 ok=false if phoneNumber missing or non-E.164
  → 400 ok=false if text.trim() empty
  → IF callerAliasId provided: verifyCallerIdAlias → from_number (E.164)
       400 ok=false ("Invalid caller-ID selection — please refresh and try again") if invalid/expired
       (callerAliasId omitted → Dialpad uses the user's default sender)
  → POST https://dialpad.com/api/v2/sms
       body: { user_id, to_numbers: [phoneNumber], from_number?, text, infer_country_code: false }
  → 502 ok=false ("Dialpad rejected the message: <upstream message>") if non-2xx
  → Response: { ok: true, messageId? }
```

Design notes:
- **Text forwarded verbatim.** Recruiters write `{{firstName}}`-templated copy and the extension does the substitution client-side. Whitespace + newlines are typed deliberately for readability — the worker never trims, re-flows, or normalises. Empty messages (after trim) are still rejected so we don't ship a blank SMS.
- **No rate-limit gate yet.** Initial deployment is single-consultant test-call mode; when production candidate-mode lights up, revisit. `src/rate-limit.js` is reusable: lift the pure decision function to take a configurable window/limit and add an `ratelimit:sms:{dialpadUserId}` key.
- **No retries.** If Dialpad rejects, the extension's popover keeps the textarea contents and re-enables the Yes button so the recruiter retries manually. Auto-retry would risk double-sending — much harder to reason about than human-in-the-loop retry.
- **PII-aware logging.** We log `textLength` but never the message body itself — once `{{firstName}}` is substituted client-side, the rendered text is candidate-identifying.

Dialpad's `initiate_call` endpoint deliberately does not take a `device_id` — Dialpad auto-rings every eligible autocallable device the consultant has registered (Electron desktop app, web, CRM embeds), and the recruiter just picks up wherever rings. This is why `/dialpad-user-context` only returns caller IDs, not devices.

### `POST /dialpad-hangup` — terminate the consultant's active call

```
Extension → POST /dialpad-hangup (consultantFirstName)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(env, name)
  → 403 ok=false if not in the registry
  → stub = EXT_CALL_STATE.get(idFromName(user.dialpadId))
  → callId = await stub.getCallId()
  → 409 ok=false ("No active call") if callId is null
  → PUT https://dialpad.com/api/v2/call/{callId}/actions/hangup   (no body)
  → 502 ok=false ("Dialpad rejected the hangup: <upstream message>") if non-2xx
  → Response: { ok: true }   ← worker does NOT clear the DO; the resulting
                                Dialpad `hangup` webhook is the only path
                                that clears
```

The extension never sees the Dialpad `call_id` — the worker reads it from the per-user `ExtCallState` Durable Object, populated by the matching `calling` webhook. The hangup body is just `{ consultantFirstName }`.

If the user hangs up via the Dialpad app instead of the extension, no `/dialpad-hangup` request fires — but the `hangup` webhook still does, and it clears the DO. Either path leaves the system consistent.

### `POST /webhook/dialpad/extension-calls` — call-state webhook handler

The single writer/clearer of the per-user `ExtCallState` Durable Object. Subscription is configured Dialpad-side for **both `calling` and `hangup`** states with no `target_id` / `target_type` filter — the subscription is company-wide and survives team-registry changes; per-user filtering happens server-side via `getUserByDialpadId(env, ...)`. Everything else (`connected`, `voicemail`, inbound, events from non-registered users) is filtered server-side and dropped silently. Same JWT auth as `/webhook/dialpad/calls` (shared `DIALPAD_WEBHOOK_SECRET`).

```
Dialpad event → POST /webhook/dialpad/extension-calls
  → JWT verify (HS256, DIALPAD_WEBHOOK_SECRET)
  → processExtensionCallEvent(payload, env):
       direction !== 'outbound' → drop (reason: not-outbound)
       payload.call_id missing → drop (reason: no-callid-in-payload)
       getUserByDialpadId(env, payload.target.id) → null → drop (reason: unmonitored-target)

       stub = EXT_CALL_STATE.get(idFromName(user.dialpadId))

       IF state === 'calling':
         await stub.setCallId(payload.call_id)   ← overwrite-on-write,
                                                    schedules a 20-min
                                                    self-clearing alarm
         return { processed: true, reason: 'set-active', callId, ... }

       IF state === 'hangup':
         result = await stub.clearCallIdIfMatch(payload.call_id)
         match → DO clears; reason: 'cleared-on-hangup'
         mismatch → DO untouched (stale event for an old call); reason: 'callid-mismatch'
         no record → reason: 'no-active-record'

       any other state → drop (reason: 'unsupported-state')

  → 200 (always — Dialpad would retry on non-200 and we don't want that)
```

The `clearCallIdIfMatch` guard protects against stale events: if a new call's `calling` event has already overwritten the DO with `callId_B`, a delayed `hangup` event for the old `callId_A` won't wipe the new state. This is why hangup match-or-ignore is the right semantics, not unconditional clear.

### `POST /extension-call-status` — extension polling endpoint

Polled by the extension every ~500ms while a call is active.

```
Extension → POST /extension-call-status (consultantFirstName)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(env, name)
  → 403 ok=false if not in the registry
  → stub = EXT_CALL_STATE.get(idFromName(user.dialpadId))
  → callId = await stub.getCallId()
  → callId set → { state: "in_progress" }
  → callId null → { state: "ended" }
```

Pure DO read — never calls Dialpad. The DO's strong consistency means every poll reads the latest webhook write regardless of which PoP each request hit (KV's cross-PoP eventual consistency was producing 1-5 second visible lag where the calling webhook had landed but polling reads still returned `ended`).

The extension owns the give-up decision via its own ~10-second clock from the `/dialpad-call` 200 — if the calling webhook never lands at all, after 10s the extension reverts the button to Call. The worker has no server-side discovery timeout.

**Lifecycle**:
1. Click Call → `POST /dialpad-call` → 200; extension shows transient `Calling…` disabled-button, starts polling, starts 10s clock.
2. Polling returns `{state: "in_progress"}` → extension flips to live Hangup, cancels 10s clock, keeps polling.
3. Polling returns `{state: "ended"}` (after Hangup state) → extension flips back to Call, stops polling.
4. 10s clock fires while still in `Calling…` (calling webhook never landed) → extension reverts to Call, stops polling.

### Mobile PWA endpoints

Two routes power the mobile PWA's home + pipeline screens. The PWA reuses the rest of the extension routes (`/candidate-details`, `/dialpad-user-context`, `/dialpad-call`, `/dialpad-sms`, `/dialpad-hangup`, `/extension-call-status`) verbatim.

- **`POST /my-sourcing-jobs`** — body `{ consultantFirstName }`. Wraps RF `GET /job/list?only_open=1` (paginated). Filters worker-side to jobs where the consultant is on `hiring_team` as `Recruiter` (case-insensitive) AND `job_status.name === "Sourcing"` (case-insensitive). Returns `{ jobs: [{id, name, company}] }`.

- **`POST /job-pipeline`** — body `{ consultantFirstName, jobId }`. Wraps RF `POST /candidate/search` with `{key:"job", values:[jobId]}` + `{key:"stage", values:["Sourced"]}` filters and `include_count: true`. Filters out candidates with no usable `linkedin_profile` (RF returns the literal string `"None"` for missing values), normalizes RF's bare slugs to full `https://www.linkedin.com/in/...` URLs, sorts by `added_time` ASC. Returns `{ jobId, stage: "Sourced", total, candidates: [{rfId, linkedinUrl}] }`.

The PWA loads `/job-pipeline` once per session, then iterates locally with prev/next, calling `/candidate-details` per card.

### Caller-ID alias signing

`src/dialpad-aliases.js` mints HS256 JWTs to swap raw E.164 numbers for opaque tokens before they leave the worker:

- **Signing key**: `LINKEDIN_EXTENSION_SECRET` (the same secret the extension already uses for `X-Extension-Token` auth — no new secret to provision).
- **Audience**: `dialpad-caller-id`. Domain-separates these from anything else signed with the same secret. A token minted for caller-ID lookup can never be replayed against another JWT-using path.
- **Expiry**: 7 days. Caller-ID lists rarely change in practice and the extension's local 1h cache typically expires long before the alias does — picking a longer TTL avoids any race where the cached alias outlives its server-side validity.
- **Payload**: `{ n: "+1...", iat, exp, aud }`.
- **Verification failures** (tampered, expired, wrong audience, malformed, missing) all return `null` — never throw. The route handler turns `null` into a 400 with a stable user-facing message.

Tradeoff: the JWT format means a determined extension user could base64-decode the body to read the underlying number. That number is one of their own consultant's caller IDs, fetched seconds earlier from Dialpad — there's no real secret to leak. The crucial property is tamper-resistance: the extension can't forge an alias for an arbitrary number and trick the worker into dialling out from it. HMAC handles that.

### Extension Caching Strategy

The bulk-add → cold-call session pattern (50-200 candidates added at once, walked through one-by-one over 1-3 days) is the primary perf target. Two cooperating layers:

**1. Snapshot caches** (`details:{rfId}`, `activities:{rfId}`, both 20-min TTL):
- First `/candidate-details` for a candidate is a RF round-trip + KV write
- Subsequent reads within 20 min are KV-only (~30-50ms total)
- `/candidate-mark-invalid` invalidates so tag changes show up immediately

**2. Neighbor prewarm via per-job batch index**:
- `/candidates/add-to-job` appends successful rows (added OR already_in_job, deduped) to `batch:job{jobId}` — an ordered JSON array of rfIds in add-order, 30-day TTL
- On `/candidate-details`, after picking the job, fire `ctx.waitUntil(handleNeighborPrewarm(rfId, jobId, recruiterRfUserId, env))`:
  - Find the candidate's index in the batch list. Skip if not in any batch index.
  - Read `prewarm:rec{rfUserId}:job{jobId}` for last prewarm position (1-hour TTL).
  - **First call** (no state): prewarm 30 candidates either side (clipped to list bounds), set `lastPrewarmIdx = currentIdx`.
  - **Subsequent calls**: if `|currentIdx - lastPrewarmIdx| >= 20`, prewarm the next 30 in the direction of motion. Update state.
  - Otherwise: no-op.
- Prewarm uses `prewarmCandidatesIfMissing(rfIds, env)` which only fetches RF for pieces not already cached.

This pattern means:
- Recruiter walks through profiles 1, 2, 3, ... in a job
- Profile #1: ~600ms (RF GET + activity-list + cache writes + prewarms #2-30)
- Profiles #2-30: ~30-50ms each (KV-only)
- At profile #21: directional prewarm fetches #31-60 in background
- Profile #31: still ~30-50ms (already prewarmed)

`getRFCandidate` retries once on 502 — RF's edge produces transient 502s and a single retry is far cheaper than failing the whole sidepanel response.

All four extension routes return `{ "error": "Internal Server Error" }` on 500 (server-side `console.error` still carries `error.message` + stack — full debug context stays in CF Logs, generic body keeps RF internals from leaking to clients).

Cache hit/miss is logged at multiple layers — filter `source:prewarm`, `source:consultant-cache`, or look for `cacheHit:` fields to verify behavior in CF Observability.

---

## MCP layer — claude.ai connector → middleware

The Recruiterflow MCP integration is a two-Worker split:

```
claude.ai connector
   │ DCR + OAuth (PKCE / S256) ──▶ example-team.cloudflareaccess.com
   │                                  └── OTP login ──▶ JWT (aud=ACCESS_AUD_MCP)
   │
   │ POST /mcp + Authorization: Bearer <JWT>
   ▼
rf-mcp-remote (mcp-worker/)
   │ verifyAccessJwt(req, env, ACCESS_AUD_MCP)
   │ → factory-per-request McpServer (CVE GHSA-345p-7cg4-v4c7)
   │ → registerTools(server, { env, consultantEmail })
   │ → createMcpHandler dispatches the tool call
   │
   │ tool body → mwFetch(ctx, '/mcp/<name>', args)
   │   - service binding (no DNS, no public network hop)
   │   - merges consultantEmail (verified) into body, overriding caller-supplied
   │   - no shared-secret header
   ▼
rf-dialpad-sync-dev /mcp/* router (src/mcp/router.js)
   │ getUserByEmail(env, body.consultantEmail) → consultant
   │ (falls back to getUserByFirstName(env, body.consultantFirstName) for legacy callers,
   │  logs '[mcp] legacy consultantFirstName fallback')
   │ → handler({ env, ctx, body, consultant })
   ▼
src/mcp/<name>.js
   │ resolvers (resolveCandidate / resolveJob / resolveStage / resolveOwner)
   │ D1 reads via session(env) from src/mcp/d1-read.js (read-after-write within session)
   │ NEVER writes D1 — that's the sync worker's exclusive responsibility
   ▼
JSON response → mwFetch → tool body → MCP stream → claude.ai
```

The MCP worker is **stateless**: it owns no D1, no KV, no Durable Object, no RF API key. Its only job is JWT validation + service-binding forwarding. The middleware does ALL alias / fuzzy / acronym resolution server-side; clients never need IDs.

Full middleware semantics (resolvers, ID short-circuit, default fields per endpoint, lean disambiguation envelopes, recovery shapes, custom-field universe memoization) live in [`docs/mcp-middleware.md`](mcp-middleware.md). That doc is the working reference for adding a new MCP endpoint or changing resolver behaviour.

### Dialpad-call → structured RF note (MCP)

`rf_candidate_call_notes` is a recruiter-driven three-step flow: list Dialpad calls (≥2 min) with a candidate → fetch the chosen call's transcript and the call-notes rendering brief → submit the structured markdown back to RF as a candidate note via `/candidate/notes/add`. Authentication is the same Access-JWT-derived consultant; an additional per-record check on stage 2 (`call.target.id == consultant.dialpadId`) prevents cross-consultant transcript reads. Lives at `/mcp/candidate-call-notes`; full spec in `docs/archive/specs/2026-05-10-candidate-call-notes-design.md`.

---

## Sync worker — `rf-mcp-cache-sync`

Sole writer of `RF_MCP_CACHE` (D1). Deployed independently from the same monorepo via the GitHub build watch path on `sync-worker/`. Owns its own `wrangler.sync.jsonc`, `vitest.config.js`, and `migrations/`.

### What it does

- **Scheduled cron (currently OFF)**: every 15 min the `scheduled()` handler ran `tailSync(env)` and then created a new `PipelineRebuildWorkflow` instance. The cron block is commented out in `wrangler.sync.jsonc` as of 2026-05-10 — see "Why the cron is off" below.
- **`POST /admin/full-rebuild`** (always available): authed by `X-Admin-Token` (timing-safe compare against `ADMIN_SECRET`). Optional `?only=candidates|jobs|pipelines` narrows the rebuild. Spins up a new `FullRebuildWorkflow` instance and returns `{ ok, workflow_id }` with HTTP 202.
- **`FullRebuildWorkflow`** (`sync-worker/src/workflow.js` + `runFullRebuild`): walks RF's paginated `/candidate/list` (100 rows/page), refreshes `users`/`activity_types`/`custom_fields` into `sync_state`, refreshes `/job/list`, then delegates to `PipelineRebuildWorkflow` for every open job. In-flight token claim/release wraps the full run.
- **`PipelineRebuildWorkflow`** (`sync-worker/src/pipeline-workflow.js` + `runPipelineRebuild`): one `step.do` per open job. Each step fetches RF `/job/pipeline?job_id=X`, normalizes via `normalizePipelineDetail`, and writes the row through `writeJobPipeline`. Per-step retries (3 attempts, exponential backoff) come from the Workflow runtime — one bad job's fetch failing doesn't block the rest.

### Why the cron is off

The 15-min tick was firing both `tailSync` (which `INSERT-OR-REPLACE`s every job in `jobs`) AND `PipelineRebuildWorkflow` (which `INSERT-OR-REPLACE`s every row in `job_pipelines`) regardless of whether any row had actually changed. Tail-sync of candidates `INSERT-OR-REPLACE`s every candidate in the cursor window. With ~zero active MCP consumers, this drove ~1M D1 writes/day for nothing.

**Do not re-enable** until `writeJobs`, `writeJobPipeline`, and `writeCandidatesAndLinks` gate on per-row change detection (compare new payload hash / `last_updated` against the current row before writing). The full rebuild Workflow is still callable on demand; webhook-driven cache writes on the main worker are unaffected.

### Tail-sync cursor semantics (unchanged)

`fetchCandidatesUpdatedSince` returns `{ ids, suggestedCursor }`. `suggestedCursor` is `min(returned)` when the response was capped by `HARD_CAP` (so dropped edge rows get picked up next tick) and `max(returned)` otherwise. **Do not recompute the cursor from per-candidate `last_updated`** — that skips dropped rows and silently loses updates when the cap fires.

---

## Loop Prevention

Both RF→Dialpad and Dialpad→RF sync directions write a KV debounce flag (`sync:RF{id}`, 60-second TTL) after a successful sync. The opposite direction checks for this flag before proceeding. This prevents infinite loops:

```
RF webhook fires → sync to Dialpad → set sync:RF{id}
  → Dialpad fires webhook (echo) → check sync:RF{id} → exists → skip
  → 60s later → flag expires → normal Dialpad updates proceed
```

The calendar handler also sets this flag after updating RF, preventing the subsequent RF webhook from re-syncing to Dialpad (the calendar handler already upserted Dialpad directly).

---

## Storage

### KV — `SYNC_STATE`

Single KV namespace bound on both the main worker and the sync worker. Holds debounce flags + the cross-integration candidate/index cache + extension snapshot caches + per-recruiter prewarm state + rate-limit state.

| Key Pattern | Value | TTL | Owner |
|-------------|-------|-----|-------|
| `candidate:{rfId}` | Slim JSON: `{id, first_name, last_name, email, emails[], linkedin_profile, current_organization, current_title, phone_number, cached_at}` | 60 days | main |
| `linkedin:{normalized_url}` | RF candidate ID string | 60 days | main |
| `email:{lowercase_address}` | RF candidate ID string (one key per email in array) | 60 days | main |
| `name:{first_lower}:{last_lower}` | RF candidate ID string, or `"AMBIGUOUS"` | 60 days | main |
| `sync:RF{id}` | `"true"` (debounce flag) | 60 seconds | main |
| `krisp:note:{hash}` | `"true"` (dedup flag) | 24 hours | main |
| `coldcall:{call_id}` | `"true"` (dedup flag, set before AI classification) | 5 minutes | main |
| `apollo_enrich:{rfId}` | JSON enrichment context (`apolloPersonId` or `noMatch:true`) | 15 minutes | main |
| `consultant:job{jobId}:cand{rfId}` | RF user_id string or `"none"` sentinel | 30 days | main |
| `details:{rfId}` | Full RF `/candidate/get` response (extension fast path) | 20 minutes | main |
| `activities:{rfId}` | Full `/candidate/activity/list` data array | 20 minutes | main |
| `batch:job{jobId}` | JSON array of rfId strings in extension-add order | 30 days | main |
| `prewarm:rec{rfUserId}:job{jobId}` | `{ lastPrewarmIdx }` per-recruiter+job state | 1 hour | main |
| `ratelimit:call:{dialpadUserId}` | JSON `[{t: ms-epoch, phone: E164}]` rolling-window state for `/dialpad-call` rate-limit + dedup | 120 sec | main |

Active Dialpad `call_id` per consultant — formerly `extcall:callid:{dialpadUserId}` in KV — now lives in the `ExtCallState` Durable Object (see "Durable Object" below).

### Cache freshness invariant

All webhook flows keep the candidate cache up to date (Krisp is the exception — it only reads the cache for lookups, does not write):

| Webhook | When cache is written |
|---------|----------------------|
| RF (Created/Updated) | After Dialpad sync — caches full candidate data from RF payload |
| Dialpad (Updated) | After RF update — merges email/phone/LinkedIn changes into cached record. Cache miss → fetches fresh from RF API. Also checks pending cold calls by phone |
| Calendar | After RF search API hit (warms cache). After successful email merge (updates cached emails) |
| Dialpad Calls | Writes `coldcall:{call_id}` dedup. Reads candidate via `getRFCandidate` for tag merge and Sourced→Replied stage move (cache itself is not written by this flow) |

Webhook-driven writes are the only freshness mechanism for the candidate/index cache — the sync worker's tail-sync was a backup, not a primary, and is currently off. **If you add a write path that mutates RF candidate data, you must also update the KV cache.** Otherwise integration lookups by LinkedIn / email / name silently go stale.

### Name Ambiguity

The name index uses an `"AMBIGUOUS"` sentinel to prevent wrong-candidate matches:

1. First candidate with name "John Smith" → `name:john:smith` = `"12345"`
2. Second different candidate "John Smith" → `name:john:smith` = `"AMBIGUOUS"`
3. Lookups against `"AMBIGUOUS"` return null — the name match is too risky
4. Same candidate re-cached → no change (rfId matches, skip)
5. Ambiguity persists until TTL expires (60 days)

### LinkedIn URL Normalization

URLs are normalized before cache key generation: strip protocol (`https?://`), strip `www.`, strip query params/fragments, strip trailing slashes, lowercase. Both `/in/` and `/pub/` LinkedIn URL formats are supported.

Example: `https://www.LinkedIn.com/in/John-Smith/?utm_source=share` → `linkedin.com/in/john-smith`

### D1 — `RF_MCP_CACHE`

Shared between the sync worker (writer) and the main worker (reader). Schema in `sync-worker/migrations/`:

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `candidates` | Slim canonical row + full body JSON for fuzzy/text reads | `id` PK; indexes on `primary_email`, `linkedin_profile`, `lead_owner_id`, `last_updated`, `added_time` |
| `candidate_jobs` | One row per (candidate, job) link | `(candidate_id, job_id)` PK; indexes on `(job_id, disqualified, stage_name)`, `(added_to_job_by_id, job_id)`, `(job_id, added_to_job)` |
| `jobs` | Slim canonical job row + full body JSON | `id` PK; index on `is_open` |
| `job_pipelines` | Per-job pipeline summary + active candidates by stage | `job_id` PK; index on `fetched_at` |
| `sync_state` | Singleton key-value store: `last_full_rebuild_at`, `last_tail_sync_at`, `in_flight`, RF user list, activity-type list, custom-field schema | `key` PK |

**Discipline rule (do not violate):** the main worker has D1 SELECT permission on `RF_MCP_CACHE` but **must never write**. The sync worker is the sole writer. This invariant keeps the sync surface auditable and prevents schema drift between writers.

### D1 — `USERS_DB`

Owned by the main worker (writes via `migrations/`, reads via `src/users.js`). Distinct database from `RF_MCP_CACHE`.

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | Team registry (six members) | `email` PK (lowercase + LIKE-form CHECK); UNIQUE indexes on `dialpad_id`, `rf_user_id`, `first_name`. Columns: `rf_user_id`, `dialpad_id`, `first_name`, `calendar_mode` (`outlook`/`gcal`/`both`), `aliases` (JSON array of alternate first-names), `created_at`, `updated_at` |

**Adding a teammate** = a new SQL migration applied via `wrangler d1 execute --remote rf-users --file migrations/000N_<name>.sql`, then a Worker redeploy so the cold-start cache picks up the new row. The module-level cache in `src/users.js` is invalidated only on Worker restart.

### Durable Object — `ExtCallState`

`EXT_CALL_STATE` → class `ExtCallState` (defined in `src/extension-call-do.js`, re-exported from `src/index.js` so wrangler picks it up). One DO instance per Dialpad user, named deterministically via `idFromName(dialpadUserId)`. Strong consistency: every read sees every prior write, regardless of which PoP each request hit.

- **Storage**: a single `callId` key. Holds the active Dialpad `call_id` for the user, or absent.
- **RPC methods**:
  - `setCallId(callId)` — overwrite-on-write; schedules a 20-min self-clearing alarm.
  - `getCallId()` — returns the stored value or `null`.
  - `clearCallIdIfMatch(callId)` — clears iff the stored value matches; otherwise drops with a reason. Used by the hangup webhook to avoid wiping a newer call when a stale event arrives.
- **Alarm**: fires 20 min after the last `setCallId`. Cleans up abandoned records (Dialpad never delivered a matching hangup webhook). A new `setCallId` resets the alarm.
- **Migration history**: `v1` created the now-deleted `ExtensionCallStateChannel` (the SSE-fan-out DO from the previous architecture); `v2` deleted it; `v3` added `ExtCallState`.

The previous KV-backed `extcall:callid:*` design was eventually consistent across PoPs — a `calling` webhook landing at one PoP and a poll at another could be 1-5 seconds out-of-sync, producing visible "no active call → ended" windows after the call had already started. Routing every request through a single DO instance eliminates that staleness window.

---

## External API Patterns

### RF API

- **Auth**: `RF-Api-Key` header
- **Search**: `POST /candidate/search` with `filters[]`, `conjunction: "match-all"`, `current_page: 1`, `items_per_page: N`
- **Get**: `GET /candidate/get?id=X`
- **Update**: `POST /candidate/update` with `{id, ...fields}` — **REPLACES arrays, does not append**. Always GET first to merge.
- **Add note**: `POST /candidate/notes/add` with `{candidate_id, notes}` — used by Krisp integration to attach meeting notes as HTML.
- **Webhook delay**: RF webhooks can take ~2 hours to fire after a candidate edit. Delivery is fast once they fire.

### Dialpad API

- **Auth**: `Authorization: Bearer {DIALPAD_API_KEY}`
- **Upsert contact**: `PUT /contacts` with UID-based idempotency
- **UID format**: `RF{candidateId}` → Dialpad generates full ID `shared_contact_pool_Company:{companyId}_uid_RF{candidateId}`
- **Webhook auth**: JWT (HS256) in Authorization header or raw body
- **User caller-IDs**: `GET /users/{userId}/caller_id` → flat shape `{ caller_id, phone_numbers, office_main_line, groups[], ... }` (NOT wrapped in `caller_id_proto` despite some old docs samples)
- **Initiate call**: `POST /users/{userId}/initiate_call` with `{ phone_number, outbound_caller_id }`. We deliberately omit `device_id` — Dialpad auto-rings every eligible autocallable device the user has registered, which is exactly what we want
- **Send SMS**: `POST /sms` with `{ user_id, to_numbers (array, ≤10), text, ... }`. Rate-limited 100/min (Tier 0) or 800/min (Tier 1). `from_number` overrides the user's default sending number when provided

### Cloudflare Access

- **JWKS**: `GET {ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
- **Verification**: RS256 signature against the JWKS, `iss === env.ACCESS_TEAM_DOMAIN`, `aud === env.ACCESS_AUD_*` (per app), email + sub claims non-empty. Helper: `verifyAccessJwt` (same shape in `src/access-auth.js` and `mcp-worker/src/access-auth.ts`).

---

## Environment

### Secrets (set via `wrangler secret put`)

#### Main worker — `rf-dialpad-sync-dev`

| Secret | Used by |
|--------|---------|
| `DIALPAD_API_KEY` | Dialpad API (Bearer token auth) |
| `RF_API_KEY` | RF API (`RF-Api-Key` header) |
| `DIALPAD_WEBHOOK_SECRET` | JWT verification for Dialpad webhooks |
| `RF_WEBHOOK_SECRET` | Shared secret verification for RF webhooks |
| `CALENDAR_WEBHOOK_SECRET` | Shared secret verification for calendar webhooks |
| `KRISP_WEBHOOK_SECRET` | Shared secret verification for Krisp webhooks |
| `APOLLO_API_KEY` | Apollo API (Bearer auth) |
| `APOLLO_WEBHOOK_SECRET` | Token query param verification for Apollo phone webhooks |
| `LINKEDIN_EXTENSION_SECRET` | Shared secret for `X-Extension-Token` on extension routes; also used as the HMAC key for opaque caller-ID aliases on `/dialpad-user-context` and `/dialpad-call` (domain-separated by JWT audience). Retired when Spec B Phase 3 lands. |
| `ACCESS_AUD_MIDDLEWARE` | Cloudflare Access AUD for the extension-API app — **not yet set**; provisioned during Spec B |

#### MCP worker — `rf-mcp-remote`

| Secret | Used by |
|--------|---------|
| `ACCESS_AUD_MCP` | Cloudflare Access AUD for `rf-mcp-remote`. 64-char hex tag from the App 1 dashboard. |

#### Sync worker — `rf-mcp-cache-sync`

| Secret | Used by |
|--------|---------|
| `RF_API_KEY` | RF API (`RF-Api-Key` header) — independent secret from the main worker's |
| `ADMIN_SECRET` | `X-Admin-Token` for `POST /admin/full-rebuild` |

### Test bindings (in `vitest.config.js` / `vitest.config.ts`, never deployed)

`vitest.config.js`'s `poolOptions.workers.miniflare.bindings` provides non-secret stand-ins for `LINKEDIN_EXTENSION_SECRET`, `RF_API_KEY`, `DIALPAD_API_KEY`, `DIALPAD_WEBHOOK_SECRET`, and `ACCESS_TEAM_DOMAIN` so e2e tests can hit the worker (and mint valid Dialpad webhook JWTs / Access JWTs) without real credentials. Sister configs in `sync-worker/vitest.config.js` and `mcp-worker/vitest.config.ts` do the same for those workers' bindings (in particular, the MCP worker's tests inject a fixture-derived `ACCESS_AUD_MCP` and an RSA-keypair JWKS via `_setJwksForTests`). `wrangler.jsonc` is intentionally clean of secret values to avoid overwriting Cloudflare-managed production secrets on deploy.

### Vars (in `wrangler.jsonc` / sister configs)

| Var | Default | Set on |
|-----|---------|--------|
| `DIALPAD_API_BASE_URL` | `https://dialpad.com/api/v2` | main worker |
| `RF_API_BASE_URL` | `https://api.recruiterflow.com/api/external` | main worker, sync worker |
| `ACCESS_TEAM_DOMAIN` | `https://example-team.cloudflareaccess.com` | main worker, MCP worker |

### KV namespace

`SYNC_STATE` — single namespace for both debounce flags and candidate cache.
- Production ID: `REDACTED_KV_NAMESPACE_ID`
- Preview ID: `REDACTED_KV_PREVIEW_NAMESPACE_ID`

Bound on the main worker (read+write) and the sync worker (read+write — shared rate-limit / sync-state writes only; the candidate/index cache is main-worker-owned).

### D1 databases

| Binding | Database name | Owner | Migrations |
|---------|---------------|-------|------------|
| `RF_MCP_CACHE` | `rf-mcp-cache` (id `e1ba6c0f-...`) | sync worker (writer); main worker (reader) | `sync-worker/migrations/` |
| `USERS_DB` | `rf-users` (id `8cc7f951-...`) | main worker (writer via migrations) | `migrations/` (root) |

### Durable Object

`EXT_CALL_STATE` (class `ExtCallState`) — main worker only. Migration tags v1/v2/v3 documented above.

---

## Deployment

- **Auto-deploy**: Push to `master` triggers deployment via the GitHub integration. Each Worker has its own watch-path config:
  - Main worker (`rf-dialpad-sync-dev`) — root + `src/` + `migrations/` + `wrangler.jsonc`
  - Sync worker (`rf-mcp-cache-sync`) — `sync-worker/` subtree
  - MCP worker (`rf-mcp-remote`) — `mcp-worker/` subtree
- **Manual**: `npm run deploy` in each worker's directory.
- **Worker names** — the `-dev` suffix on the main worker is intentional; it's the live production URL and is what the integration webhooks point at.
