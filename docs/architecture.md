# Architecture & Data Flow

> **Architectural state.** Three points of standing context for the rest of this doc:
>
> - **Auth.** All user-facing endpoints are fronted by Cloudflare Access OAuth. The MCP path is fully migrated; the extension/PWA path runs a dual-auth helper (`src/auth-extension.js`) that accepts both an Access JWT and the legacy `X-Extension-Token` header during rollout. New user-facing endpoints MUST go through `authExtensionRequest` — see `docs/security.md` for the convention.
> - **Read cache.** `RF_MCP_CACHE` (D1) is mid-migration from a heavyweight legacy schema to a "thin-immutable" one (`candidates_v2`, `jobs_v2`, `calls`). The thin tables are the active write path; a small set of legacy tables are still read by a few code paths and are dropped at the final cutover step. The thin redesign exists to eliminate a write-amplification problem the legacy full-rewrite cron caused — see § Cache worker.
> - **Call state.** The active Dialpad `call_id` per user lives in a per-user `ExtCallState` Durable Object (strong consistency). The Dialpad `calling`+`hangup` webhook (`/webhook/dialpad/extension-calls`) is the only writer; `/dialpad-call`, `/dialpad-hangup`, and `/extension-call-status` are read-only.

## System Overview

Three core Cloudflare Workers cooperate around a shared set of D1 + KV bindings (two more sit alongside the core and are covered elsewhere: `rf-cf-metrics-poller`, an independent hourly observability sidecar — see § Observability; and `rf-music-remote`, the isolated music-control plane bridging the team's extensions to the office-TV kiosk — see [`docs/music-worker.md`](music-worker.md)):

- **`rf-dialpad-sync-dev`** (main worker, this repo's root) — the integration hub. Receives webhooks from RecruiterFlow (RF), Dialpad, Google Calendar, Krisp, and the LinkedIn extension; writes to RF + Dialpad APIs; serves the extension and PWA routes; also serves the internal `/mcp/*` API consumed only over a service binding from the MCP worker. Owns `USERS_DB` (D1) and `SYNC_STATE` (KV) writes; reads `RF_MCP_CACHE` (D1).
- **`rf-mcp-cache-sync`** (cache worker, `cache-worker/` subtree) — the **sole writer** of `RF_MCP_CACHE` (D1). Runs a 15-min cron with two parallel paths: the legacy `tailSync` (gated behind `CRON_LEGACY_ENABLED='false'` default; intentionally inert during the dual-write window — see `cache-worker/src/index.js` § `getCacheCronLegacyFlag`) and the new additive-only `tailSyncThin` (active — gated by `CRON_THIN_ENABLED='true'`, set 2026-05-12 as cutover step 5; the code-level fallback is `'false'` when the var is unset). On-demand Workflows: `FullRebuildWorkflow` (legacy repopulation), `CacheSeedWorkflow` (per-table thin-schema seed); `PipelineRebuildWorkflow` (legacy per-job pipeline refresh) still exists in `cache-worker/src/pipeline-workflow.js` but is no longer instantiated from `scheduled()`. Also accepts `POST /admin/cache-rebuild?table=` for the new seed path and `POST /internal/calls/upsert` (service-binding-only, from main worker) for live call-cache writes.
- **`rf-mcp-remote`** (MCP worker, `mcp-remote/` subtree) — the public Streamable-HTTP MCP server consumed by claude.ai. Stateless TypeScript Worker; validates the Cloudflare Access JWT, then service-binds into the main worker's `/mcp/*` surface. Owns no storage; never reads RF directly.

RF is the source of truth for candidate records. The KV `SYNC_STATE` cache provides fast lookups for integrations that don't have an RF candidate ID, and short-TTL snapshot caches make the extension's sidepanel responsive when recruiters walk through bulk-added candidate queues.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ RecruiterFlow │ │   Dialpad    │  │  Dialpad     │  │   Google     │  │    Krisp     │  │   LinkedIn   │
│   (RF)       │  │  (contacts)  │  │  (calls)     │  │  Calendar    │  │              │  │  Extension   │
│              │  │              │  │              │  │  + Reclaim   │  │              │  │ (Chrome) +   │
│              │  │              │  │              │  │              │  │              │  │ Mobile PWA   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ webhook         │ webhook         │ webhook         │ Apps Script      │ webhook         │ POST (Bearer JWT or X-Extension-Token)
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
│    D1  RF_MCP_CACHE     — thin-immutable cache (READ-ONLY here; cache worker writes)                      │
│    DO  EXT_CALL_STATE   — per-user active Dialpad call_id (ExtCallState class, idFromName(dialpadId))   │
│    DO  COLD_CALL_ARBITER— per-call cancelled-vs-transcript grace arbiter (ColdCallArbiter, idFromName(callId)) │
│    AI  Workers AI       — cold-call classifier (Llama 3.3 70B) + summary extractor (Llama 3.1 8B)       │
│    Svc SYNC_WORKER      — service binding to rf-mcp-cache-sync (hangup forwarding → /internal/calls/upsert)│
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                ▲                                                                          │
                │ service binding                                                          │ wrangler d1 execute / deploy refresh
   ┌────────────┴─────────────────┐                                              ┌─────────▼──────────────┐
   │  Cloudflare Worker:           │                                             │ Cloudflare Worker:      │
   │  rf-mcp-remote (mcp-remote/)  │                                             │ rf-mcp-cache-sync       │
   │                               │                                             │ (cache-worker/)          │
   │  POST /mcp                    │                                             │                         │
   │   ↓ verifyAccessJwt           │                                             │ POST /admin/full-rebuild│
   │   ↓ MIDDLEWARE.fetch(/mcp/*)  │                                             │ POST /admin/cache-rebuild│
   │  GET /health                  │                                             │ POST /internal/calls/upsert│
   │                               │                                             │ scheduled() — cron ON   │
   │  Bindings:                    │                                             │   tailSync (legacy)     │
   │    Service: MIDDLEWARE        │                                             │   tailSyncThin (new,    │
   │    Vars: ACCESS_TEAM_DOMAIN   │                                             │     CRON_THIN_ENABLED)  │
   │    Secret: ACCESS_AUD_MCP     │                                             │                         │
   │                               │                                             │ Workflows:              │
   │  ↓ Authorization: Bearer JWT  │                                             │   FullRebuildWorkflow   │
   └─────────────▲─────────────────┘                                             │   PipelineRebuildWflw   │
                 │                                                               │   CacheSeedWorkflow     │
                 │ DCR + OAuth (PKCE/S256)                                       │ Bindings:               │
            ┌────┴──────────┐                                                    │   D1: RF_MCP_CACHE (rw) │
            │ claude.ai     │                                                    │   D1: USERS_DB (ro)     │
            │ MCP connector │                                                    │   KV: SYNC_STATE        │
            └───────────────┘                                                    │   Workflow bindings     │
                                                                                 └──────────────────────┬──┘
                                                                                                        │
                                                                                                        │ writes (INSERT-OR-IGNORE)
                                                                                                        │ candidates_v2, jobs_v2, calls
                                                                                                        │ + legacy dual-write: candidates,
                                                                                                        │ candidate_jobs, jobs, job_pipelines,
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
│  - App 2 (extension API) — Phase 2 live; App 2 + both secrets set, extension on OAuth                    │
│  - Login: Email OTP. Reusable policy `rf-team` (Allow if email ends @<your-team-domain>)                 │
│  → Full auth detail in docs/security.md                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Security

All user-facing endpoints (browser, AI client, extension) are converging on Cloudflare Access OAuth — App 1 (`rf-mcp-remote`) is live; App 2 (extension API) is also live — App 2 created, both `ACCESS_AUD_MIDDLEWARE` + `ACCESS_CLIENT_ID_MIDDLEWARE` secrets set, and the extension ships on OAuth (the dual-auth helper still accepts the legacy `X-Extension-Token` until the rollout drain completes — Phase 3 removes it). Webhook endpoints keep their existing per-source signed-token auth. Service-binding traffic between workers is implicitly trusted within the account boundary; the upstream worker validates the JWT once and forwards a body field with the verified identity.

**Read [`docs/security.md`](security.md)** before adding/touching any user-accessible endpoint, header, or anything tied to identity. That doc is canonical for: provider config (team domain, OTP login, reusable `rf-team` policy), application registrations, the JWT validation helper API (`verifyAccessJwt` — same shape in `src/access-auth.js` and `mcp-remote/src/access-auth.ts`), env vars (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD_MCP`, `ACCESS_AUD_MIDDLEWARE`, `ACCESS_CLIENT_ID_MIDDLEWARE`), and the identity flow end-to-end.

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
| `src/auth-extension.js` | Dual-auth gate for user-facing extension routes. Accepts SaaS-OIDC JWT (`Authorization: Bearer` or `Cf-Access-Jwt-Assertion`) or legacy `X-Extension-Token`. JWT success envelope: `{ ok: true, source: 'jwt', user, email, sub }`. The `sub` claim is the durable identity (used by `/sms-templates` to scope storage). |
| `src/sms-templates.js` | Handlers for `GET /sms-templates`, `PUT /sms-templates/{id}`, `DELETE /sms-templates/{id}`. JWT-only (rejects legacy `X-Extension-Token`); records scoped by `sub`. Defense-in-depth validation: name ≤80, body ≤2000, per-user cap 50, body.id must equal path id. Server does NOT stamp `createdAt` / `updatedAt` — extension is authoritative. |
| `src/cache.js` | KV cache: canonical records, index keys (linkedin, email, name), consultant_id per job-link, details + activities snapshots, batch index, prewarm state, invalidation helper. |
| `src/rf-client.js` | RF API client: search/get/update, LinkedIn URL validation & normalization, Dialpad↔RF data conversion, custom-field consultant_id read/write/resolve, activity-list, phone normalization (`normalizeToE164`), job disambiguation (`pickConsultantJob`), stage-move filter, prewarm helper, single-retry-on-502 in `getRFCandidate`. |
| `src/dialpad-client.js` | Dialpad API client: contact PUT (create/update), data preparation from RF candidate format, `getUserCallerId` and `initiateCall` for the LinkedIn extension calling flow, `buildCallerIdsFromDialpad` (pure transform → opaque-alias `callerIds[]`), `sendSMS` (POST `/sms` rolled-params wrapper), `hangupCall({ callId })` (PUT `/call/{id}/actions/hangup`). |
| `src/dialpad-aliases.js` | Opaque caller-ID alias signing/verifying (HS256 JWT via jose, audience `dialpad-caller-id`, 7-day TTL). Keeps raw E.164 numbers off the wire. |
| `src/rate-limit.js` | Rolling-window rate-limit + cheap dedup gate for `/dialpad-call`. Pure decision function + KV-backed `checkAndRecordCall`. 5 calls/60s rolling per Dialpad user_id, plus a 3s per-(user,phone) dedup window for double-clicks. |
| `src/krisp.js` | Krisp helpers: note formatting (HTML), and `resolveKrispAttribution` — resolves the consultant (note author) + candidate from meeting participants by team membership. |
| `src/cold-call.js` | Cold call detection: monitored-user filter (registry-driven), **Sourced gate (`selectSourcedJob`) before any AI**, Dialpad transcript fetch, Workers AI classification (Llama 3.3 70B), per-outcome summary extraction (Llama 3.1 8B), RF custom activity + tag/source update + Sourced→Replied stage move, generic `mergeTag(tags, value)` helper, `parseColdCallActivity` for the extension shape, `finalizeCancelledColdCall` (mechanical no-AI cancelled-call write, called by the arbiter DO). |
| `src/extension-calls.js` | Extension Call/Hangup webhook dispatcher. `processExtensionCallEvent` filters Dialpad webhook payloads (outbound + monitored target), routes `calling`/`hangup` events to the per-user `ExtCallState` DO. |
| `src/extension-call-do.js` | `ExtCallState` Durable Object class. Per-user store, one instance per Dialpad user (`idFromName(dialpadUserId)`). RPC: `setCallId`, `getCallId`, `clearCallIdIfMatch`. 20-min self-clearing alarm on `setCallId`. |
| `src/cold-call-arbiter.js` | Dispatches Dialpad call webhook events to the per-call `ColdCallArbiter` DO: `signalTranscriptToArbiter` (transcript states) and `routeHangupToArbiter` (never-connected outbound hangups). Mirrors `extension-calls.js`. |
| `src/cold-call-arbiter-do.js` | `ColdCallArbiter` Durable Object — per-call (`idFromName(call_id)`) grace-timer arbiter giving transcripts priority over cancelled calls. Pure state-machine fns (`arbiterMarkCancelled`/`arbiterMarkTranscript`/`arbiterAlarm`) + thin DO shell. `alarm()` finalizes via the SELF binding → `/internal/coldcall/finalize-cancelled`. |
| `src/apollo-client.js` | Apollo API client: enrichment, search, verification, scoring. |
| `src/enrichment.js` | Legacy enrichment orchestration (RF Created owner-gated + manual webhook): ownership check (sourced from `users.js`), LinkedIn verify, fallback search, phone reveal. The primary enrichment path is the extension add flow + the Apollo webhook handler in `src/handlers/apollo-enrichment.js`. |
| `src/phone-merge.js` | Pure phone merge + ranking engine for the Apollo webhook: exclusion (work_*/ext/invalid), type-based best-first ordering (mobile > home > other, pre-existing manual numbers stay at top). No I/O — `applyApolloEnrichment` (`src/handlers/apollo-enrichment.js`) owns the I/O. |
| `src/mcp/router.js` | `/mcp/*` dispatcher. Resolves consultant from body field — prefers verified `consultantEmail` (forwarded by `rf-mcp-remote` from the Access JWT); transitional `consultantFirstName` fallback for legacy callers (logs `[mcp] legacy consultantFirstName fallback`, drops at the auth Phase 3 cutover). No header auth — only callable over the service binding. |
| `src/mcp/{cache-status,candidate-get,candidate-search,candidate-move-stage,candidate-log-interview,job-pipeline,job-candidates-filter,candidate-call-notes}.js` | Per-tool middleware handlers. |
| `src/mcp/{resolvers,fuzzy,projection,linkedin,d1-read,snapshot,handlers-registry,concurrency}.js` | Shared middleware infrastructure. `concurrency.js` provides `pMapLimit` for bounded parallel RF `/candidate/get` fan-out in pipeline hydration. |
| `src/webhook/dialpad-hangup-forwarder.js` | Forwards Dialpad hangup webhook payloads to cache-worker via service binding for live `calls` table insertion. Fire-and-forget inside `ctx.waitUntil`; cron backstop catches any drops. |
| `src/stage-stats.js` | The stage-movement stats plane: pipeline-positional classification (+ per-job pipeline KV cache), London week windows, STAGE_EVENTS D1 store (conditional upsert + latest-event-wins aggregate + reconcile waterline), the shared ingest engine, change-gated dashboard push fan-out, and the webhook/pull/reconcile/backfill handlers. RF calls live in `src/rf-client.js`; the main worker's `scheduled()` (cron `7 * * * *`) runs the hourly waterlined reconcile. Canonical doc: [`docs/stage-stats.md`](stage-stats.md). |
| `src/lib/timing-safe-equal.js` | Constant-time string compare for shared-secret headers (same implementation as the cache worker's local helper). |
| `migrations-stage-events/0001_create_stage_events.sql` | `STAGE_EVENTS` D1 schema (database `rf-stage-events`, owned read+write by the main worker). |
| `migrations/0001_create_users.sql`, `migrations/0002_seed_users.sql` | `USERS_DB` schema + seed data (six teammates). Email PK with lowercase + LIKE-form CHECK constraints; UNIQUE indexes on `dialpad_id`, `rf_user_id`, `first_name`. |
| `migrations/0003_create_sms_templates.sql` | `USERS_DB.sms_templates` — per-user SMS template store backing `/sms-templates`. Composite PK `(sub, id)`; `sub` is the JWT identity, `id` is a client-minted UUID v4. CHECK constraints on name length (1..80) and body length (≤2000). Index on `(sub, updated_at DESC)` powers the list-ordered-by-recency query. |
| `scripts/calendar-sync.gs` | Google Apps Script: detects Reclaim bookings on Google Calendar, extracts candidate data, posts to worker. |
| `wrangler.jsonc` | Worker config: KV/D1/DO/AI bindings, vars, compatibility settings (no secrets — those are Cloudflare-managed). |
| `vitest.config.js` | Vitest + miniflare config; test-only secret bindings live here, not in wrangler.jsonc. |
| `test/index.spec.js`, `test/e2e.spec.js`, `test/extension-calls.spec.js`, `test/rf-client.spec.js`, `test/access-auth.spec.js`, `test/users-d1.spec.js`, `test/pwa-endpoints.spec.js`, `test/mcp-*.spec.js`, `test/helpers/{d1-migrate,users-migrate}.js` | Vitest tests using `@cloudflare/vitest-pool-workers`. |

### Cache worker (`cache-worker/`, deploys as `rf-mcp-cache-sync`)

| File | Purpose |
|------|---------|
| `cache-worker/src/index.js` | Entry. Exports `default` with `scheduled()` and `fetch()`. `scheduled()` runs the legacy `tailSync(env)` unconditionally (dual-write phase) and then `tailSyncThin(env)` when `CRON_THIN_ENABLED=true`. `tailSyncThin` fans out to three parallel additive subtasks via `Promise.allSettled`: `tailSyncCandidatesThin`, `tailSyncJobsThin`, `tailSyncCallsThin`. `fetch()` routes `/admin/*` to `handleAdmin` and `/internal/*` to `handleInternal`. Re-exports `FullRebuildWorkflow`, `CacheSeedWorkflow`, `PipelineRebuildWorkflow`. |
| `cache-worker/src/workflow.js` | Legacy `FullRebuildWorkflow` + `runFullRebuild` (candidates page-walk, jobs, users, activity_types, custom_fields, pipelines). New `CacheSeedWorkflow` + `runCacheSeed` — per-table thin-schema initial seed, triggered by `POST /admin/cache-rebuild?table=candidates\|jobs\|calls`. |
| `cache-worker/src/pipeline-workflow.js` | Legacy `PipelineRebuildWorkflow` + `runPipelineRebuild`. One `step.do` per open job; fetches RF `/job/pipeline`, normalizes via `normalizePipelineDetail`, writes via `writeJobPipeline`. Kept during dual-write phase; dropped at cutover step 6. |
| `cache-worker/src/d1-write.js` | D1 write helpers. Legacy: `writeCandidatesAndLinks` (INSERT-OR-REPLACE, candidate-boundary atomicity via D1 `batch()`), `writeJobs` (INSERT-OR-REPLACE), `writeJobPipeline`. New thin: `writeCandidatesThin` (INSERT-OR-IGNORE on `candidates_v2`), `writeJobsThin` (INSERT-OR-IGNORE on `jobs_v2`), `writeCalls` (INSERT-OR-IGNORE on `calls`). All thin writers are idempotent by PK. |
| `cache-worker/src/normalize.js` | RF payload → D1 row builders. Legacy: `toCandidateRow`, `toCandidateJobRows`. New thin: `toCandidateThinRow` (id, name, linkedin_profile, added_time_ms, title/company at-cache-time snapshots, cached_at_ms), `toJobThinRow` (id, name, client_company_name, added_time_ms, canonical_pipeline_json, cached_at_ms), `toCallRow` (call_id, target_dialpad_id, dialpad_contact_id, rf_candidate_id, date_started_ms, duration_ms, direction, cached_at_ms). |
| `cache-worker/src/pipeline-normalize.js` | Legacy RF `/job/pipeline` → D1 pipeline row normalization (used by `PipelineRebuildWorkflow`). |
| `cache-worker/src/rf-list-client.js` | Cache-worker's RF API client. Existing paginated endpoints (`/candidate/list`, `/job/list`, etc.). New: `fetchCandidatesAddedSince(env, cursor)` — RF `/candidate/search` with `added_on` date filter; cap-aware MIN-advance cursor (capped → MIN `added_time` across batch; not-capped → MAX `added_time`). |
| `cache-worker/src/dialpad-list-client.js` | `listDialpadCallsPage(opts, env)` (single page → `{items, cursor}`) and `listDialpadCalls(opts, env)` (internal loop with `maxPages` cap, default 25). All Dialpad query params optional; omitting `targetId`/`targetType` lists org-wide. Per-page structured `console.log` per request. Seed paginates externally via `step.do` per page; cron uses the looping form for a bounded recency window. |
| `cache-worker/src/users-d1-read.js` | `listConsultants(env)` — read-only enumeration of `USERS_DB.users` from cache-worker. Returns `[{email, dialpadId, rfUserId, firstName}]`. Used by cron calls subtask and seed Workflow for per-consultant fan-out. Column is `dialpad_id` (not `dialpad_user_id`). |
| `cache-worker/src/sync-state.js` | Read/write/delete helpers over the `sync_state` D1 table. Tracks: `last_full_rebuild_at`, `last_tail_sync_at`, `in_flight`, `last_candidates_added_cursor` (thin cron cursor), plus RF user/activity-type/custom-field caches. |
| `cache-worker/src/users.js` | Cache-worker-internal copy of team registry. Used during legacy user enrichment; does NOT replace the main worker's `src/users.js`. |
| `cache-worker/migrations/0001_init.sql` | Initial schema: legacy `candidates`, `candidate_jobs`, `jobs`, `sync_state`. |
| `cache-worker/migrations/0002_job_pipelines.sql` | Legacy `job_pipelines` table. |
| `cache-worker/migrations/0003_v2_tables.sql` | **Thin-immutable schema:** `candidates_v2`, `jobs_v2`, `calls`. Coexists with legacy tables during dual-write cutover. |
| `cache-worker/migrations/0005_missed_cold_calls.sql` | `missed_cold_calls` — owner-only historical cancelled/missed cold-call backfill store. Populated once by `scripts/backfill-cancelled-cold-calls.mjs`; read by the main worker's `/candidate-details` join. |
| `cache-worker/migrations-pending/0004_drop_legacy.sql` | **Staged out of the migrations dir until cutover step 6.** Moved back to `cache-worker/migrations/` and applied at step 6 only. Drops `candidates`, `candidate_jobs`, `jobs`, `job_pipelines`. |
| `cache-worker/wrangler.cache.jsonc` | Cache-worker config: RF_MCP_CACHE (rw) + USERS_DB (ro) D1 bindings, KV, Workflow bindings (`REBUILD_WORKFLOW`, `PIPELINE_REBUILD_WORKFLOW`, `CACHE_SEED_WORKFLOW`), `workers_dev: false` (closes public workers.dev subdomain), `CRON_THIN_ENABLED` env var (set `"true"` since 2026-05-12 to run the additive cron; code-level fallback `"false"` when unset) plus `CRON_LEGACY_ENABLED` `"false"` (legacy writers inert). Cron trigger active (`*/15 * * * *`). |
| `cache-worker/vitest.config.js` | Vitest config for cache-worker tests. |
| `cache-worker/test/{admin,d1-write,normalize,pipeline-normalize,pipeline-workflow,rf-list-client,sync-state,tail-sync,workflow,internal-calls-upsert,cache-worker}.spec.js` | Cache-worker tests. `internal-calls-upsert.spec.js` covers the service-binding endpoint idempotency; `index.spec.js` covers cron e2e against mocked RF + Dialpad. |

### MCP worker (`mcp-remote/`, deploys as `rf-mcp-remote`)

| File | Purpose |
|------|---------|
| `mcp-remote/src/index.ts` | Entry. `fetch()` validates the Access JWT against `env.ACCESS_AUD_MCP`, builds a fresh per-request `McpServer` (factory-per-request — required by MCP SDK ≥1.26.0, CVE GHSA-345p-7cg4-v4c7), dispatches via `createMcpHandler` from `agents/mcp`. `GET /health` returns `ok`; everything but `POST /mcp` returns 404. |
| `mcp-remote/src/access-auth.ts` | TypeScript twin of `src/access-auth.js`. Same public API (`verifyAccessJwt`), same RS256 lock, same empty-string defense, same lowercase email return. Exports a `_MODULE_ID` sentinel to guard against vite resolving to the main worker's JS file via relative-path fallback. |
| `mcp-remote/src/tools.ts` | `registerTools(server, ctx)` — registers the seven MCP tools (`rf_candidate_search`, `rf_candidate_get`, `rf_candidate_move_stage`, `rf_candidate_log_interview`, `rf_job_candidates_filter`, `rf_job_pipeline`, `rf_cache_status`). Each tool body calls `mwFetch` over the service binding; max-result truncation at 140k chars. |
| `mcp-remote/src/mw-client.ts` | Thin client over the `MIDDLEWARE` service binding. Hostname is conventional only (binding dispatches by binding, not DNS). Always merges `consultantEmail` (verified, from JWT) into the request body, overriding any caller-supplied value. No header-based auth — service-binding traffic is trust-local. |
| `mcp-remote/src/instructions.ts` | Server-instructions string Claude sees on session start. |
| `mcp-remote/wrangler.mcp.jsonc` | MCP-worker config: `MIDDLEWARE` service binding to `rf-dialpad-sync-dev`, `ACCESS_TEAM_DOMAIN` var, observability. `ACCESS_AUD_MCP` is a secret. |
| `mcp-remote/test/{access-auth,auth,tool-dispatch}.spec.ts`, `mcp-remote/test/jwt-fixture.ts`, `mcp-remote/test/env.d.ts` | TypeScript tests with a shared RSA-keypair JWT fixture. |
| `mcp-remote/vitest.config.ts` | Vitest config; injects `ACCESS_TEAM_DOMAIN` and a fixture-derived `ACCESS_AUD_MCP` into the test env. |

### Observability libs (all workers)

| File | Purpose |
|------|---------|
| `src/lib/*.js`, `cache-worker/src/lib/*.js`, `mcp-remote/src/lib/*.ts`, `metrics-poller/src/lib/*.ts` | OTel helpers — `flow-names`, `otel-config`, `body-capture`, `logs-bridge`, `ld-resource-injector`, plus per-worker additions (`ai-instrument`, `trace-link`, `instrumented-step`, `bootstrap-otel`). Byte-identical copies across workers with closed-set drift tests. See `docs/observability.md`. |
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
| `/webhook/recruiterflow/stage-moved` | POST | `X-RF-Webhook-Token` header (timing-safe) | RF stage-moved events → enrich + STAGE_EVENTS D1 + dashboard push (see [`docs/stage-stats.md`](stage-stats.md)) |
| `/stats/stage-aggregate?afterMs=&beforeMs=` | GET | `X-Stats-Token` header (`STATS_PULL_TOKEN`, timing-safe) | CV-Sent / 1st-Interview aggregate for a caller-chosen window (dashboard puller + LAST-WEEK toggle) |
| `/admin/stage-stats/reconcile` | POST | `X-Stats-Token` header (timing-safe) | The hourly reconcile sweep on demand |
| `/admin/stage-stats/backfill` | POST | `X-Stats-Token` header (timing-safe) | Cursor-batched historical stage-movement walk (seed / recovery / label-change re-run) |
| `/webhook/dialpad` | POST | JWT Bearer (HS256) | Dialpad contact Updated events |
| `/webhook/calendar` | POST | `X-Calendar-Webhook-Token` header | Calendar booking events (from Apps Script) |
| `/webhook/krisp` | POST | `X-Krisp-Webhook-Token` header | Krisp meeting note webhooks |
| `/webhook/dialpad/calls` | POST | JWT Bearer (HS256) | Dialpad call `transcription`/`call_transcription` (→ AI cold-call flow) + `hangup` (→ cancelled-call arbiter DO) |
| `/webhook/dialpad/extension-calls` | POST | JWT Bearer (HS256) | Dialpad call-state (`calling`/`hangup`) webhook driving the extension button |
| `/internal/coldcall/finalize-cancelled` | POST | `X-Internal-Token` header (timing-safe, `INTERNAL_SECRET`) | Internal-only — the `ColdCallArbiter` DO's grace-alarm finalize callback (via SELF binding). Writes the mechanical cancelled cold-call activity. |
| `/webhook/apollo` | POST | `?token=` query param (`APOLLO_WEBHOOK_SECRET`) | Async phone-reveal delivery from Apollo. Merges all desirable numbers into RF + Dialpad (ranked). See "Apollo phone enrichment (multi-number waterfall)". |
| `/candidates` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | LinkedIn extension batch upsert (sets `lead_owner_id`) |
| `/candidates/add-to-job` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Add candidates to a job + write `consultant_id` custom field |
| `/candidate-details` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Sidepanel data: rfId, phone (E.164), picked job, cold-call activities |
| `/candidate-mark-invalid` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Tag candidate `"Number Invalid"` (idempotent) |
| `/dialpad-user-context` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Caller-ID picker data (opaque aliases, no raw E.164) |
| `/dialpad-call` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Initiate call via Dialpad `initiate_call` |
| `/dialpad-sms` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Send a single SMS via Dialpad `/sms` |
| `/dialpad-hangup` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Terminate the consultant's active call |
| `/extension-call-status` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Polled ~every 500ms by extension after a `/dialpad-call` |
| `/call-stats` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Daily call counter for the consultant — pure KV read from `callstats:daily:{rfUserId}:{YYYY-MM-DD}`. Body `{consultantFirstName}` (legacy) or none (JWT). Returns `{ daily }`. |
| `/my-sourcing-jobs` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Mobile PWA home screen — open Sourcing-status jobs the consultant is on |
| `/job-pipeline` | POST | Cloudflare Access Bearer JWT or `X-Extension-Token` (legacy) | Mobile PWA pipeline view — Sourced-stage candidates for a job |
| `/sms-templates` | GET | **Cloudflare Access Bearer JWT only** | List SMS templates for the authenticated user. Scoped by JWT `sub`. Returns `{ templates: SmsTemplate[] }` ordered by `updated_at DESC`. Storage in `USERS_DB` (table `sms_templates`). |
| `/sms-templates/{id}` | PUT | **Cloudflare Access Bearer JWT only** | Upsert by `(sub, id)`. Body is the full record; server does NOT stamp `createdAt` / `updatedAt`. Enforces `name ≤80`, `body ≤2000`, per-user cap of 50. Returns `{ ok: true }` on success, 400 on validation, 409 on cap. |
| `/sms-templates/{id}` | DELETE | **Cloudflare Access Bearer JWT only** | Idempotent delete scoped to `(sub, id)`. Missing id returns 200. |

> **Auth migration in flight (Phase 2 live, Phase 3 pending):** the `X-Extension-Token` + `consultantFirstName`-in-body shape is being replaced in two phases. Phase 2 (live): middleware accepts both Cloudflare Access JWTs and the legacy header; the OAuth extension has shipped and the legacy path keeps working while `auth.source=legacy` traffic drains. Phase 3 (future): drop the legacy header + front the worker with Access edge mode (path filter excludes `/webhook/*` and `/test/coldcall`).

### Service-binding-only routes — main worker

These land on `rf-dialpad-sync-dev` but are NOT publicly addressable. They're called only via the `MIDDLEWARE` service binding from the MCP worker (`rf-mcp-remote`), which is itself behind Cloudflare Access. Auth is "service-binding origin is trusted within the Cloudflare account boundary"; identity arrives as a `consultantEmail` body field, derived from a JWT verified upstream.

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/mcp/cache-status` | POST | service binding (trusted) — `consultantEmail` body | Sync-state stamps + table counts; cheap health probe |
| `/mcp/candidate-search` | POST | service binding (trusted) — `consultantEmail` body | Filter (D1 SELECT) and/or fuzzy (in-memory snapshot) candidate search |
| `/mcp/candidate-get` | POST | service binding (trusted) — `consultantEmail` body | Single candidate by id or fuzzy query (auto-disambiguates) |
| `/mcp/candidate-move-stage` | POST | service binding (trusted) — `consultantEmail` body | RF `/candidate/move-to-stage` — fuzzy-resolves candidate/job/stage |
| `/mcp/candidate-log-interview` | POST | service binding (trusted) — `consultantEmail` body | RF custom-activity (Interview); returns `outlook_url` / `gcal_hint` for calendar handoff |
| `/mcp/job-candidates-filter` | POST | service binding (trusted) — `consultantEmail` body | Flat list of active candidates on a job (live RF + conditional D1 hydration) |
| `/mcp/job-pipeline` | POST | service binding (trusted) — `consultantEmail` body | Per-job pipeline view, candidates grouped by stage (live RF + conditional D1 hydration) |
| `/mcp/candidate-call-notes` | POST | service binding (trusted) — `consultantEmail` body | Three-step flow: list calls (D1 `calls` SELECT), fetch transcript, submit note |

> A transitional `consultantFirstName` body fallback is honoured by the router for legacy callers (logs `[mcp] legacy consultantFirstName fallback`); it disappears at the auth Phase 3 cutover. New endpoints should not rely on it.

Full middleware semantics (resolvers, ID short-circuit, default fields, recovery envelopes) are documented in [`docs/mcp-middleware.md`](mcp-middleware.md).

### Public routes — MCP worker (`rf-mcp-remote`)

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/mcp` | POST | Cloudflare Access JWT (RS256, `aud === ACCESS_AUD_MCP`) | Streamable-HTTP MCP — DCR + tool calls |
| `/health` | GET | None | Health check (`ok`) |

The MCP worker validates the JWT, builds a fresh per-request `McpServer` (mandatory for MCP SDK ≥1.26.0), then `createMcpHandler` from `agents/mcp` dispatches the tool call. Every tool body calls `mwFetch` over the service binding into the corresponding `/mcp/*` route on the main worker.

### Cache worker (`rf-mcp-cache-sync`) routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/admin/full-rebuild?only=<candidates\|jobs\|pipelines\|null>` | POST | `X-Admin-Token` (`ADMIN_SECRET`, timing-safe) | Kicks off legacy `FullRebuildWorkflow`. Returns `{ ok, workflow_id }` HTTP 202. |
| `/admin/cache-rebuild?table=<candidates\|jobs\|calls>&since=<iso>` | POST | `X-Admin-Token` (`ADMIN_SECRET`, timing-safe) | Kicks off `CacheSeedWorkflow` for the specified thin-schema table. `since` is optional (calls only — defaults to 2 years). Returns `{ ok, workflow_id }` HTTP 202. |
| `/internal/calls/upsert` | POST | `X-Internal-Token` (`INTERNAL_SECRET`, timing-safe) | Service-binding-only endpoint. Accepts a Dialpad hangup payload and INSERT-OR-IGNORE into `calls`. Validates `call_id`, `target.id`, `date_started` fields. The workers.dev subdomain is disabled (`workers_dev: false`), so this is only reachable via service binding from the main worker. |

The 15-min `scheduled()` handler runs `tailSyncThin` (active, `CRON_THIN_ENABLED='true'` since 2026-05-12) and the legacy `tailSync` (inert, `CRON_LEGACY_ENABLED='false'` default — logs `skip_legacy_tail_sync` and returns). At cutover step 6 the legacy `tailSync` function + both env-var gates are dropped entirely.

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

## Contact-field dedupe (phone/email uniqueness)

RF enforces uniqueness on phone and email. When any `/candidate/update` tries to add a value already held by a **different** candidate (a stale duplicate, usually added with a wrong/missing LinkedIn so it never deduped), RF returns `409 {"message":"A profile with this Phone Number|Email already exists"}`. This used to throw and silently kill downstream steps (most visibly the calendar flow's stage move + Dialpad upsert + cache).

Dedupe is built into `updateRFCandidate` itself (`src/rf-client.js`), so **every** update path benefits — calendar, Dialpad→RF, Apollo, extension:

```
updateRFCandidate → 409 phone/email exists
  → find the OTHER candidate owning the value (searchRFCandidateByPhone / searchRFCandidateByEmail)
  → GET it in full; VERIFY it actually holds the value (RF search is substring-loose, so a
    hit isn't proof of ownership — strip and search must stay in lockstep)
  → strip the value from that record (non-destructive: candidate stays, only the value leaves;
    re-promotes a surviving email to primary if the stripped one was primary)
  → retry the target update (we TRUST the target — it carries the correct LinkedIn)
  → bounded to 2 passes (phone + email) so it always terminates
```

**Policy**: always trust the target and strip from the other record — the same-person / record-thinness assessment is **logged signal only**, never a gate (per the team's decision). Every resolution emits a detailed `source:'dedupe'` warn log (both candidate ids + names, the value, and `flag: review_delete` when the losing record is thin / `manual_merge` when it has substance) for human follow-up; wire an alert channel via a LaunchDarkly alert rule on `source = "dedupe"`. If no owner can be located the value is left alone and the update throws `RFContactConflictUnresolvedError` (typed, so callers degrade gracefully) with `flag:'conflict_unresolved'`.

Separately, `addCandidateToJob`'s expected `409 "already present in the job pipeline"` is **not** an error — it returns `{status:'already_in_job'}` instead of logging+throwing, so the common re-add case no longer pollutes the error views.

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

**Trigger**: Krisp fires the `note_generated` webhook after a meeting ends and the AI meeting notes are ready.

```
Krisp webhook (note_generated)
  → POST /webhook/krisp
  → Verify X-Krisp-Webhook-Token (fail closed)
  → Check KV dedup: krisp:{meeting.id} — skip if already processed (7-day TTL)
  → resolveKrispAttribution(participants):
      consultant = first participant whose email resolves to a team member
                   (getUserByEmail, incl. krisp_emails alias) → note author
      candidate  = the external (guest-shaped) participant
  → Find RF candidate (two-tier lookup):
      Tier 1: Email cache lookup (lookupByEmail)
      Tier 2: RF search API (searchRFCandidateByEmail), then cacheCandidate on hit
  → Render data.raw_content (markdown) → HTML note (formatKrispNotesAsHtml)
  → POST /candidate/notes/add to RF with created_by = consultant.rfUserId
      (fallback: the owner's rfUserId if no consultant resolved, + warning log)
  → On success: set dedup flag krisp:{meeting.id} = "true" (7-day TTL)
```

**Attribution**: the note is authored by the consultant on the call, resolved
from participants by team membership. A consultant's Krisp-account email is
often distinct from their team `email`; the `krisp_emails` column on
`USERS_DB.users` (folded into the `byEmail` map, primary email wins on
collision) maps those aliases. If no participant resolves to a team member
(their `krisp_email` isn't registered yet) the note is attributed to the owner
with a warning, and the candidate is identified via the Krisp structural
signal (`id`/`first_name` populated = consultant; null = guest) so an
unregistered consultant is never mistaken for the candidate.

**Payload**: the `note_generated` event carries the notes as a single markdown
string in `data.raw_content` (the retired `summary_generated` event used a
`data.content[]` section array). `formatKrispNotesAsHtml` renders the markdown
subset Krisp emits — `#`..`######` headings, `- `/`* ` bullets, `**bold**`,
`---` rules — to RF's supported tag set (`<b>`, `<br>`, `<ul>`/`<li>`, `<a>`),
prefixed with a clickable Krisp link + meeting metadata. A structured
`data.sections` object (`action_items`/`key_points`/`outline`) also ships but is
frequently null; `raw_content` is the source of truth. See
`docs/references/krisp_example_payload.json`.

**Scope**: One-way, read-only integration. Krisp data flows to RF as candidate notes only. No data flows back to Krisp, no Dialpad sync triggered, no cache updates needed.

**Dedup**: KV key `krisp:{meeting.id}`, written only after a successful note
post (at-least-once: a failed post returns 500 so Krisp retries). The 7-day TTL
comfortably exceeds Krisp's re-delivery/retry window so a late *sequential*
re-delivery of the same meeting does not double-post (notes are immutable once
posted). The flag is read-then-written (not claimed before processing), so two
*concurrent* in-flight deliveries of the same meeting can both pass the check
and double-post — an accepted residual window, traded for the at-least-once
"never lose a note" guarantee.

---

## Data Flow: Dialpad Calls → RF (Cold Call Detection)

**Trigger**: Dialpad fires `call_transcription` / `transcription` (voicemail) when a transcript is ready, OR `hangup` when a call ends. Cold-call contacts are always pre-linked via the LinkedIn extension, so the call payload arrives with an RF candidate UID embedded in `contact.id`. The webhook handler routes by `state`: transcript states run the AI classification flow below (and signal the arbiter); `hangup` routes to the cancelled-call path (see "Cancelled calls").

```
Dialpad call event (call_transcription or transcription state)
  → POST /webhook/dialpad/calls
  → Verify JWT (HS256, DIALPAD_WEBHOOK_SECRET)
  → signalTranscriptToArbiter(call_id) — tell the per-call ColdCallArbiter DO a
    transcript exists, so any pending cancelled for the same call is suppressed
    (transcript always wins).

  → Pre-LLM filters (cheap, fail-fast, exit before any KV / Dialpad / AI call):
      - target.id must be in USERS_DB (registry-driven via isMonitoredDialpadUser)
      - direction must be "outbound"
      - contact.id must contain an RF UID (uid_RF regex, String() coerced)

  → Set KV dedup: coldcall:{call_id} = "true" (5-min TTL) BEFORE candidate/transcript fetch

  → Sourced gate (applies to ALL outcomes — voicemail/connected/cancelled):
      - GET /candidate/get?id=X (fetched once here, reused for the tag merge)
      - selectSourcedJob(candidate, activityUserId, env): the candidate must be
        in 'Sourced' on the consultant's relevant open job (consultant-matched
        via resolveJobConsultantId, jobs[0] fallback). If not Sourced → skip
        entirely (no activity/tag/source, no AI). This is what stops in-process
        candidates being run through cold-call classification.

  → Get transcript:
      - transcription state: transcription_text from payload (voicemails)
      - call_transcription state: GET /api/v2/transcripts/{call_id}
  → Truncate to 5,000 chars
  → Classify via CF Workers AI (Llama 3.3 70B fp8 fast)
  → If not cold call → log + done

  → Cold call detected:
      1. Reuse the candidate fetched at the Sourced gate (RF /candidate/update
         REPLACES array fields including tags, so we merge onto existing tags).
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

### Cancelled calls (ColdCallArbiter DO)

A Dialpad outbound call that rang but never connected (`hangup` with no talk
time — `duration` is 0/absent; the call object has **no** `date_connected` field)
produces no transcript, so the AI flow above never sees it and the cold count is
understated. (Connected calls and outbound voicemails-left both have `duration > 0`
and produce a transcript, so they're handled by the AI flow.) These are recorded
**mechanically (no AI)**
as cancelled cold calls — but a transcript, if one ever arrives for the same
call, must win (a call where Dialpad detected speech is a voicemail, not a
cancel), and call-state webhooks can arrive out of order. RF has no
activity-delete, so we can't write-then-undo. The coordinator is a per-call
**`ColdCallArbiter` Durable Object** (`COLD_CALL_ARBITER`, `idFromName(call_id)`):

```
hangup (outbound, duration 0/absent = never connected, monitored, RF-mapped)
  → routeHangupToArbiter → DO.markCancelled(payload)  → arm GRACE_MS alarm (~2min)
call_transcription / transcription
  → signalTranscriptToArbiter → DO.markTranscript()   → suppress cancelled (now or later)

DO.alarm() (grace elapsed, no transcript seen):
  → SELF.fetch POST /internal/coldcall/finalize-cancelled  (X-Internal-Token)
     → finalizeCancelledColdCall: Sourced gate → type-1002 activity
       "Cold call with {name} — Cancelled" + source/tag update. NO stage move.
  → mark finalized; CLEANUP_MS alarm (~1h) then deleteAll (dedup duplicate deliveries)
```

Both webhook branches hit the **same** DO instance, so its single-threaded
execution serializes them — no race, strong read-after-write (KV's cross-PoP
eventual consistency is unreliable here, same reason ExtCallState is a DO). The
DO holds 2-3 flags for the grace+cleanup window then self-deletes — a grace-timer,
not call-state tracking. The `alarm()` finalize routes back through the worker's
own instrumented fetch handler via the **SELF** service binding so the mechanical
write is fully traced (`flow.name = ColdCallCancelledFinalize`) and span-linked to
the originating webhook (via `_otel_trace` in the callback URL). `GRACE_MS` is
tuned to exceed the observed hangup→`call_transcription` lag (p99 + margin); a
transcript arriving *after* the grace is the one residual edge (a rare,
owner-only-visible cancelled+voicemail duplicate that can't be deleted).

> **Dialpad-side step**: the cancelled path only fires once Outbound `hangup` is
> added to the `/webhook/dialpad/calls` subscription. Until then the `hangup`
> branch is inert — safe to deploy ahead of the Dialpad change.

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

> **Auth model is mid-rework (Phase 2/3).** Phase 2 dual-auth helper is live in `src/auth-extension.js` — extension routes accept both Cloudflare Access JWTs and the legacy `X-Extension-Token` header. The `X-Extension-Token` + `consultantFirstName`-in-body shape is removed in Phase 3 (once the operator confirms a 24-hour drain of `auth.source=legacy` after extension rollout). See [`docs/security.md`](security.md) for the convention all new user-facing endpoints must follow.

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
          → Apollo phone reveal on EVERY add with a linkedin URL (NOT gated on "no
            Dialpad phone" — the waterfall can surface a better number even when one
            exists; the merge engine preserves existing numbers). 120s apollo_enrich:{rfId}
            flag is a double-submit guard only.

      If new:
          → mapExtensionToRFCandidate(ext, consultantRfUserId)
              — sets lead_owner_id from registry when consultantRfUserId is a number
          → POST /candidate/add (recover from 409 by re-routing to existing path)
          → Build slim candidate record from extension data (no GET round-trip needed —
            new candidates have no email/phone yet)
          → syncCandidateToDialpad → cacheCandidate
          → Apollo phone reveal (LinkedIn URL → enrichPerson, request reveal with
            reveal_phone_number + run_waterfall_phone, write apollo_enrich:{rfId} flag)

  See "Apollo phone enrichment (multi-number waterfall)" below for the webhook side.

  → listOpenJobs → response includes { total, created, updated, skipped, errors,
                                       results, jobs }
```

### Apollo phone enrichment (multi-number waterfall)

The request side (above) is fire-and-forget: the extension add returns immediately. Apollo
delivers revealed numbers asynchronously to `/webhook/apollo?token=…&rfId=…` (seconds to
minutes later). The webhook handler (`handleApolloWebhook` → `applyApolloEnrichment` in
`src/handlers/apollo-enrichment.js`) reconciles **all** desirable numbers into **both** RF and
Dialpad in one ranked order.

```
/webhook/apollo (people[0] = { id, phone_numbers[] })
  → GET existing numbers from BOTH RF (getRFCandidate) and Dialpad (getDialpadContact)
      — existing numbers kept as ORIGINAL strings (never normalized-away → no data loss)
  → buildPhoneOrder (pure, src/phone-merge.js):
      • exclude entirely: type_cd work_* (HQ/direct), extension numbers, status_cd invalid_number
        (`other` is KEPT)
      • rank best-first as ARRAY ORDER (RF `type` stays 1): pre-existing manual numbers stay
        at top, then enrichment numbers by type (mobile > home > other)
      • status_cd/confidence_cd are NOT ranking signals; DNC is ignored
  → write ordered set to RF + Dialpad, each only if its current digit-sequence differs
      (idempotent across Apollo retries). A failed write → 500 so Apollo retries; the
      seq-skip re-attempts only the still-stale side (self-heal, no divergence).
  → invalidateCandidateDetailsCache(rfId)  — kills the up-to-20-min stale window
```

There is deliberately **no waterfall re-run**. `run_waterfall_phone` is sent on the reveal,
but its only effective benefit is the **pass-1 fall-through** (when Apollo has no number, the
waterfall reaches ContactOut automatically on the first webhook). A re-reveal can NOT force
Apollo past its own DB — verified 2026-06-22: Apollo always runs its own step first and
short-circuits the rest with `request_already_fulfilled`, on every call regardless of timing,
and there is no vendor-control param (investigation report § 6b). So re-running was pure waste
and was removed.

The extension dial path is unchanged: `/candidate-details` returns `phone_number[0]`, which
is the best number because ordering is applied at write time.

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

  → cold-call activities: activities.filter(type.id === 1002).map(parseColdCallActivity)
      → isOwner = consultantRfUserId === getUserByEmail(env, OWNER_EMAIL).rfUserId
      → NON-owner: filter out outcome === 'cancelled' (preserves today's list —
        voicemail + connected only)
      → OWNER: also merge getMissedColdCallsForCandidate(env, rfId) — the
        historical cancelled/missed calls from the RF_MCP_CACHE `missed_cold_calls`
        backfill table — into the activity list (outcome 'cancelled'/'voicemail')
      → sort asc by time

  → Fire-and-forget: ctx.waitUntil(handleNeighborPrewarm(rfId, jobId, recruiterRfId, env))

  → Response: { rfId, fullName, phoneNumber, job, activities }   // activities may now carry outcome 'cancelled'
```

> Cancelled cold calls are owner-only at the read layer for now: forward ones are
> written to RF as type-1002 activities for everyone, but non-owner reads filter
> them out — the data accrues for the future team-wide extension feature. The
> `missed_cold_calls` join supplies the historical (pre-deploy) backfill, deduped
> against RF on ingest (see `scripts/backfill-cancelled-cold-calls.mjs`).

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
rf-mcp-remote (mcp-remote/)
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
   │   - candidate fuzzy: in-memory snapshot of candidates_v2 (id, name, linkedin_profile, added_time_ms)
   │   - candidate id resolve: D1 SELECT from candidates_v2 (`getThinCandidateById`) — used by
   │     `/mcp/candidate-get` as a sanity check before the live `/candidate/get` fetch.
   │   - candidate ambiguity hydration (organisation + title for top-K options): still reads
   │     `current_organization` / `current_title` from the legacy `candidates` table (`SELECT
   │     id, current_organization, current_title FROM candidates WHERE id IN (?)`) until cutover
   │     step 6 (`0004_drop_legacy.sql`) drops `candidates`. After step 6 this hydration moves
   │     to a live RF `/candidate/search` batch.
   │   - job resolve: D1 SELECT from the legacy `jobs` table (`SELECT id, name,
   │     client_company_name FROM jobs WHERE …`); `jobs_v2` exists and is dual-written but
   │     `resolveJob` / `loadJobMeta` / `loadJobs` migrate to it at cutover step 6.
   │ For mutable data: live RF call (/candidate/get, /candidate/search, /job/pipeline)
   │ For call history: D1 SELECT from `calls` table (`getCallsForCandidate`)
   │ NEVER writes D1 — that's the cache worker's exclusive responsibility
   ▼
JSON response → mwFetch → tool body → MCP stream → claude.ai
```

The MCP worker is **stateless**: it owns no D1, no KV, no Durable Object, no RF API key. Its only job is JWT validation + service-binding forwarding. The middleware does ALL alias / fuzzy / acronym resolution server-side; clients never need IDs.

**MCP read pattern after thin-immutable migration:**

- **`rf_candidate_search`** (name fuzzy): tier-1 in-memory snapshot (`candidates_v2` via `snapshot.js`) → candidate ids. If filters on mutable fields (email, company, title, owner, stage) → one RF `/candidate/search` call with `{conjunction: 'match-all', filters: [{key: 'candidate_id', conjunction: 'in', values: ids}, ...predicate]}`. No fan-out on tier-1 hits.
- **`rf_candidate_get`**: resolve id from cache → live RF `/candidate/get` (full body). No D1 body-blob read.
- **`rf_job_pipeline` / `rf_job_candidates_filter`**: one live RF `/job/pipeline?job_id=<id>` call per request. Then conditional per-candidate hydration: thin fields (default `id`, `name`, `linkedin_profile`) → D1 SELECT from `candidates_v2` (`getCandidatesByIds`); expanded fields (anything requiring live data) → parallel `/candidate/get` fan-out at concurrency 8 via `pMapLimit` (`src/mcp/concurrency.js`).
- **`rf_candidate_call_notes` step 1**: D1 SELECT from `calls` (see below).

Full middleware semantics (resolvers, ID short-circuit, default fields per endpoint, lean disambiguation envelopes, recovery shapes, custom-field universe memoization) live in [`docs/mcp-middleware.md`](mcp-middleware.md). That doc is the working reference for adding a new MCP endpoint or changing resolver behaviour.

### Dialpad-call → structured RF note (MCP)

`rf_candidate_call_notes` is a recruiter-driven three-step flow: list Dialpad calls (≥2 min) with a candidate → fetch the chosen call's transcript and the call-notes rendering brief → submit the structured markdown back to RF as a candidate note via `/candidate/notes/add`. Authentication is the same Access-JWT-derived consultant; an additional per-record check on stage 2 (`call.target.id == consultant.dialpadId`) prevents cross-consultant transcript reads. Lives at `/mcp/candidate-call-notes`.

**Step 1 is now a D1 read.** `handleListCalls` queries the `calls` table (`WHERE target_dialpad_id = ? AND rf_candidate_id = ? AND duration_ms >= 120000`, ordered by `date_started_ms DESC`, `LIMIT 20`). Response time drops from 3–15 s (paginated Dialpad live call) to ~5–10 ms. Steps 2 (transcript fetch) and 3 (note submit) are unchanged.

---

## Cache worker — `rf-mcp-cache-sync`

Sole writer of `RF_MCP_CACHE` (D1). Deployed independently from the same monorepo via the GitHub build watch path on `cache-worker/`. Owns its own `wrangler.cache.jsonc`, `vitest.config.js`, and `migrations/`.

### What it does

- **Scheduled cron (`*/15 * * * *`, ACTIVE):** `scheduled()` runs:
  1. **Legacy `tailSync`** — gated behind `CRON_LEGACY_ENABLED='false'` default; intentionally inert. `getCacheCronLegacyFlag(env)` short-circuits with `op:'skip_legacy_tail_sync'` log every tick. Will be deleted entirely at cutover step 6.
  2. **`tailSyncThin`** (gated by `CRON_THIN_ENABLED='true'`, set 2026-05-12) — three parallel INSERT-OR-IGNORE subtasks via `Promise.allSettled` (one failure doesn't block others):
     - `tailSyncCandidatesThin`: RF `/candidate/search` with `added_on` date filter → `writeCandidatesThin` → `candidates_v2`. Cursor stored as `last_candidates_added_cursor`. Cap-aware: capped → MIN `added_time` across batch; not-capped → MAX `added_time`.
     - `tailSyncJobsThin`: full re-scan of RF `/job/list` → `writeJobsThin` → `jobs_v2`. For each newly-seen job id, fetches `/job/pipeline` once to seed `canonical_pipeline_json`. (~100 jobs total; one full re-scan per tick.)
     - `tailSyncCallsThin`: ONE org-wide `/v2/call` via `listDialpadCalls` (no `target_id` filter — per-call attribution on `item.target.id`). `started_after = MAX(date_started_ms) - 6h` from the `calls` table acts as the global watermark; the 6-hour overlap absorbs the strict-`>` semantics of `started_after`. INSERT-OR-IGNORE on `call_id` PK dedups against live `/internal/calls/upsert` writes.

- **`POST /admin/full-rebuild`**: legacy. Kicks off `FullRebuildWorkflow`. Returns `{ ok, workflow_id }` HTTP 202.

- **`POST /admin/cache-rebuild?table=candidates|jobs|calls&since=<iso>`**: new thin-schema seed. Kicks off `CacheSeedWorkflow` for the specified table. `since` is optional (calls only). Returns `{ ok, workflow_id }` HTTP 202.

- **`POST /internal/calls/upsert`**: service-binding-only endpoint. Called by main worker on every Dialpad hangup. Validates `call_id`, `target.id`, `date_started`; fires `writeCalls(env, [payload])`. Gated by `X-Internal-Token` (shared secret `INTERNAL_SECRET`) for defense-in-depth. Workers.dev subdomain is disabled (`workers_dev: false`).

- **`FullRebuildWorkflow`** (`cache-worker/src/workflow.js`): legacy full repopulation — candidates page-walk, jobs, users, activity_types, custom_fields, per-job pipeline rebuild. In-flight token claim/release wraps the run.

- **`PipelineRebuildWorkflow`** (`cache-worker/src/pipeline-workflow.js`): legacy per-job pipeline snapshot refresh. Class still present in the file but no longer cron-instantiated (the spawn from `scheduled()` was removed during the thin-cache cutover). One `step.do` per open job; per-step retries (3 attempts, exponential backoff). Retained on disk pending step-6 cleanup.

- **`CacheSeedWorkflow`** (`cache-worker/src/workflow.js`): new per-table thin-schema seed. Uses `step.do` + retry semantics. Batches 200 rows per `RF_MCP_CACHE.batch(...)`. Resumable on partial failure.

### Cron history

The legacy `tailSync` path (`INSERT-OR-REPLACE`-everything semantics) was driving ~1M D1 writes/day with zero active consumers — the cron was disabled on 2026-05-10 to stop the storm. The thin-immutable redesign (2026-05-11) introduced `tailSyncThin` with INSERT-OR-IGNORE-on-PK semantics; the cron block was uncommented during the deploy (2026-05-12) and `CRON_THIN_ENABLED` flipped to `'true'` later that day after seed validation. At that point only `tailSyncThin` runs — `CRON_LEGACY_ENABLED='false'` keeps the legacy writers off. Cutover step 6 (drop legacy tables via `0004_drop_legacy.sql` + remove dual-write code) is still pending; the two env-var gates become redundant once it lands.

### Additive tail-sync cursor semantics (`fetchCandidatesAddedSince`)

Uses RF `/candidate/search` with an `added_on` date filter (not `/candidate/list` — that's offset-only, no cursor). Cursor stored in `sync_state` as `last_candidates_added_cursor`.

**Cap-aware advance:** not-capped → set cursor to MAX `added_time` seen across returned rows. Capped at 5000 ids → set cursor to MIN `added_time` seen (guarantees forward progress on the next tick; boundary-day overlap is absorbed by INSERT-OR-IGNORE on PK). Cursor never moves backwards and never jumps to "now".

### Calls cache write paths

Two complementary write paths keep the `calls` table fresh:

1. **Dialpad hangup webhook (live, ~10–50/day):** `processExtensionCallEvent` on `hangup` → `ctx.waitUntil(forwardHangupToSyncWorker(payload, env))` → service binding `POST /internal/calls/upsert`. Fails silently on 5xx (deploy race or transient); cron backstop catches the miss.

2. **Cron `tailSyncCallsThin` (every 15 min, backstop):** ONE org-wide `/v2/call` request (no `target_id` filter — per-call attribution comes from `item.target.id`) with a 6-hour `MAX(date_started_ms) - 6h` overlap window. NO per-consultant fan-out. `listDialpadCalls` from `cache-worker/src/dialpad-list-client.js` paginates with a 25-page cap (cron volume comfortably fits). INSERT-OR-IGNORE on `call_id` PK dedups across both write paths.

3. **CacheSeedWorkflow (one-shot, per-table):** invoked via `POST /admin/cache-rebuild?table=calls[&since=<iso>]` or `wrangler workflows trigger rf-mcp-cache-seed '{"table":"calls"}'`. Paginates `/v2/call` ORG-WIDE via `step.do` per page (one fetch + one D1 write per step) so each step stays well under the CF Workflows 10-min per-step timeout. The cursor checkpoints in each step's persisted output; a workflow restart resumes from the last cached step deterministically. `params.since` (ISO) bounds the lookback; omit for full target history (Dialpad returns every concluded call).

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

Single KV namespace bound on both the main worker and the cache worker. Holds debounce flags + the cross-integration candidate/index cache + extension snapshot caches + per-recruiter prewarm state + rate-limit state.

| Key Pattern | Value | TTL | Owner |
|-------------|-------|-----|-------|
| `candidate:{rfId}` | Slim JSON: `{id, first_name, last_name, email, emails[], linkedin_profile, current_organization, current_title, phone_number, cached_at}` | 60 days | main |
| `linkedin:{normalized_url}` | RF candidate ID string | 60 days | main |
| `email:{lowercase_address}` | RF candidate ID string (one key per email in array) | 60 days | main |
| `name:{first_lower}:{last_lower}` | RF candidate ID string, or `"AMBIGUOUS"` | 60 days | main |
| `sync:RF{id}` | `"true"` (debounce flag) | 60 seconds | main |
| `krisp:{meeting.id}` | `"true"` (dedup flag) | 7 days | main |
| `coldcall:{call_id}` | `"true"` (dedup flag, set before AI classification) | 5 minutes | main |
| `apollo_enrich:{rfId}` | JSON enrichment context (`apolloPersonId` or `noMatch:true`) | 15 minutes | main |
| `consultant:job{jobId}:cand{rfId}` | RF user_id string or `"none"` sentinel | 30 days | main |
| `details:{rfId}` | Full RF `/candidate/get` response (extension fast path) | 20 minutes | main |
| `activities:{rfId}` | Full `/candidate/activity/list` data array | 20 minutes | main |
| `batch:job{jobId}` | JSON array of rfId strings in extension-add order | 30 days | main |
| `prewarm:rec{rfUserId}:job{jobId}` | `{ lastPrewarmIdx }` per-recruiter+job state | 1 hour | main |
| `ratelimit:call:{dialpadUserId}` | JSON `[{t: ms-epoch, phone: E164}]` rolling-window state for `/dialpad-call` rate-limit + dedup | 120 sec | main |
| `stagestats:pipeline:{jobId}` | JSON array of the job's ordered pipeline stage names (near-immutable structure; stage-stats positional classification + reconcile gate) | 1 day | main |

Active Dialpad `call_id` per consultant — formerly `extcall:callid:{dialpadUserId}` in KV — now lives in the `ExtCallState` Durable Object (see "Durable Object" below).

### Cache freshness invariant

**KV candidate/index cache:** all webhook flows keep the KV candidate cache up to date (Krisp is the exception — it only reads the cache for lookups, does not write):

| Webhook | When KV cache is written |
|---------|----------------------|
| RF (Created/Updated) | After Dialpad sync — caches full candidate data from RF payload |
| Dialpad (Updated) | After RF update — merges email/phone/LinkedIn changes into cached record. Cache miss → fetches fresh from RF API. Also checks pending cold calls by phone |
| Calendar | After RF search API hit (warms cache). After successful email merge (updates cached emails) |
| Dialpad Calls | Writes `coldcall:{call_id}` dedup. Reads candidate via `getRFCandidate` for tag merge and Sourced→Replied stage move (KV candidate cache not written by this flow) |
| Dialpad Hangup (extension-calls) | Forwards payload to cache-worker → INSERT-OR-IGNORE into D1 `calls` table (see "Calls cache write paths" above) |

**D1 thin-immutable cache:** the `calls` table is kept fresh by the hangup webhook → service binding path (live) and `tailSyncCallsThin` cron backstop. `candidates_v2` and `jobs_v2` are additive-only (INSERT-OR-IGNORE); they accumulate new ids but mutable fields are never updated — live RF reads supply current mutable data.

**If you add a write path that mutates RF candidate data, you must also update the KV cache** so integration lookups by LinkedIn / email / name stay current. The D1 thin tables do NOT need updating for mutable-field changes — that's the design principle.

Webhook-driven writes are the only freshness mechanism for the candidate/index cache — the cache worker's tail-sync was a backup, not a primary, and is currently off. **If you add a write path that mutates RF candidate data, you must also update the KV cache.** Otherwise integration lookups by LinkedIn / email / name silently go stale.

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

Shared between the cache worker (writer) and the main worker (reader). Schema in `cache-worker/migrations/`:

**Current state (dual-write phase, cutover steps 2–5):** both legacy and thin-immutable tables coexist. MCP read paths split across the two table sets — some have migrated to thin, others still consume legacy until cutover step 6 drops them (`0004_drop_legacy.sql`, staged in `cache-worker/migrations-pending/` and moved back into `cache-worker/migrations/` at step 6).

**Thin (already on `candidates_v2` / `jobs_v2` / `calls`):**
- `src/mcp/snapshot.js` — in-memory fuzzy snapshot reads `candidates_v2` (`SELECT id, name, linkedin_profile, added_time_ms FROM candidates_v2`).
- `src/mcp/candidate-get.js` — `getThinCandidateById` cache sanity check against `candidates_v2`, then live `/candidate/get` to RF.
- `src/mcp/job-pipeline.js` + `src/mcp/job-candidates-filter.js` — default thin-field hydration via `getCandidatesByIds` (batched `SELECT … FROM candidates_v2 WHERE id IN (…)`); expanded-field requests fan out to live RF `/candidate/get`. Pipeline data itself is always live RF (`/job/pipeline?job_id=<id>`), never cached.
- `src/mcp/candidate-call-notes.js` step 1 — `getCallsForCandidate` reads the thin `calls` table (per-record auth via `target_dialpad_id` in the WHERE clause).

**Legacy (still reads `candidates` / `candidate_jobs` / `jobs`; migrates at step 6 or in the post-cutover cleanup follow-ups):**
- `src/mcp/resolvers.js` — candidate ambiguity hydration (`SELECT id, current_organization, current_title FROM candidates WHERE id IN (…)`); job fuzzy + numeric resolution (`SELECT id, name, client_company_name FROM jobs …`).
- `src/mcp/job-pipeline.js` `loadJobMeta` and `src/mcp/job-candidates-filter.js` job-id meta lookup — `SELECT id, name, client_company_name FROM jobs WHERE id = ?`.
- `src/mcp/candidate-search.js` — `getCustomFieldOptions` (technology / segment / role universe via SQLite JSON1 `json_each` against `candidates.body`); `stage_name` distinct values via `SELECT DISTINCT stage_name FROM candidate_jobs WHERE job_id = ?`; `projectMatches` body hydration for results that don't already carry a body via `SELECT id, body FROM candidates WHERE id IN (…)`.
- `src/mcp/d1-read.js` `getCandidateById` / `getCandidateByEmail` / `getCandidateByLinkedIn` — full-body reads from `candidates`. Not currently consumed by any of the migrated handlers above; retained for callers still on the legacy fast path and removed alongside step 6.

After cutover step 6 + the follow-up cleanups noted in the merge handover § 5, the resolvers + `loadJobMeta` migrate to `jobs_v2`, candidate ambiguity hydration moves to a live RF `/candidate/search` batch (or a dedicated thin column set), the custom-field universe migrates to a dedicated lookup table or live `/candidate/custom-field/list`, and the full-body lookup in `projectMatches` is dropped — every code path that needs a full body goes live to RF.

| Table | Phase | Purpose | Key columns |
|-------|-------|---------|-------------|
| `candidates` | Legacy (drop at step 6) | Slim row + full body JSON | `id` PK; indexes on `primary_email`, `linkedin_profile`, `lead_owner_id`, `last_updated`, `added_time` |
| `candidate_jobs` | Legacy (drop at step 6) | One row per (candidate, job) link | `(candidate_id, job_id)` PK; composite indexes on stage_name, added_to_job_by_id, added_to_job |
| `jobs` | Legacy (drop at step 6) | Slim row + full body JSON | `id` PK; index on `is_open` |
| `job_pipelines` | Legacy (drop at step 6) | Per-job pipeline snapshot | `job_id` PK — **replaced by live RF `/job/pipeline` reads; this table is no longer read by any MCP handler** |
| `candidates_v2` | Active (thin-immutable) | Fuzzy search seed + id index | `id` PK; UNIQUE index on `linkedin_profile WHERE NOT NULL`; index on `added_time_ms DESC`. Columns: `id`, `name`, `linkedin_profile`, `added_time_ms`, `current_title_at_cache_time`, `current_company_at_cache_time`, `cached_at_ms`. **No body blob, no mutable fields.** |
| `jobs_v2` | Active (thin-immutable) | Job name/company fuzzy index + stage list snapshot | `id` PK; index on `client_company_name`, `added_time_ms DESC`. Columns: `id`, `name`, `client_company_name`, `added_time_ms`, `canonical_pipeline_json` (stage list at first-sight, never updated), `cached_at_ms`. |
| `calls` | Active (new) | Immutable call history per consultant | `call_id` PK; composite index on `(target_dialpad_id, rf_candidate_id, date_started_ms DESC) WHERE rf_candidate_id IS NOT NULL` (MCP read path); index on `(target_dialpad_id, date_started_ms DESC)` (cron head pointer). Columns: `call_id`, `target_dialpad_id`, `dialpad_contact_id`, `rf_candidate_id`, `date_started_ms`, `duration_ms`, `direction`, `cached_at_ms`. |
| `missed_cold_calls` | Active (0005) | Owner-only historical cancelled/missed cold calls that never reached RF (backfill). Read by `/candidate-details`'s owner join. Immutable, one row per `call_id`. | `call_id` PK; index on `(rf_candidate_id, date_started_ms DESC)` (the per-candidate join). Columns: `call_id`, `rf_candidate_id`, `target_dialpad_id`, `date_started_ms`, `outcome` ('cancelled'\|'voicemail'\|'connected'), `duration_ms`, `cached_at_ms`. |
| `sync_state` | Permanent | KV-style store for cursor + metadata | `key` PK. Keys: `last_full_rebuild_at`, `last_tail_sync_at`, `last_candidates_added_cursor` (new thin cursor), `in_flight`, RF user/activity-type/custom-field caches. |

**Thin-immutable principle:** `candidates_v2` and `jobs_v2` store only immutable (or quasi-immutable) fields. Mutable fields (`current_title`, `current_organization`, `primary_email`, `lead_owner_id`, pipeline membership, stage_name) are **never cached** — MCP reads go live to RF. `calls` is inherently immutable history.

**Discipline rule (do not violate):** the main worker has D1 SELECT permission on `RF_MCP_CACHE` but **must never write**. The cache worker is the sole writer. This invariant keeps the sync surface auditable and prevents schema drift between writers.

### D1 — `USERS_DB`

Owned by the main worker (writes via `migrations/`, reads via `src/users.js`). Distinct database from `RF_MCP_CACHE`.

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | Team registry (six members) | `email` PK (lowercase + LIKE-form CHECK); UNIQUE indexes on `dialpad_id`, `rf_user_id`, `first_name`. Columns: `rf_user_id`, `dialpad_id`, `first_name`, `calendar_mode` (`outlook`/`gcal`/`both`), `aliases` (JSON array of alternate first-names), `created_at`, `updated_at` |
| `sms_templates` | Per-user SMS template store backing `/sms-templates`. Cloud backup for the extension's local-first template list — `chrome.storage.local` is authoritative on the client. | Composite PK `(sub, id)`. `sub` = OIDC sub claim from App 2 JWT (durable identity). `id` = client-minted UUID v4 (server does not validate format, only non-empty). Columns: `name` (1..80 chars, CHECK-enforced), `body` (≤2000 chars, CHECK-enforced), `created_at` / `updated_at` (TEXT, ISO-8601 from the client — server does NOT stamp). Secondary index on `(sub, updated_at DESC)` powers list-by-recency. Per-user cap of 50 enforced in the handler. |

**Adding a teammate** = a new SQL migration applied via `wrangler d1 execute --remote rf-users --file migrations/000N_<name>.sql`, then a Worker redeploy so the cold-start cache picks up the new row. The module-level cache in `src/users.js` is invalidated only on Worker restart.

**SMS templates conflict policy.** Cloud is last-write-wins per-device; the worker stores whatever the most recent PUT sent. No server-side merge or reconciliation — the extension reads cloud once on sidepanel mount when local is empty, then never again. Different devices keep their own local truth.

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
- **Verification**: RS256 signature against the JWKS, `iss === env.ACCESS_TEAM_DOMAIN`, `aud === env.ACCESS_AUD_*` (per app), email + sub claims non-empty. Helper: `verifyAccessJwt` (same shape in `src/access-auth.js` and `mcp-remote/src/access-auth.ts`).

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
| `LINKEDIN_EXTENSION_SECRET` | Shared secret for `X-Extension-Token` on extension routes; also used as the HMAC key for opaque caller-ID aliases on `/dialpad-user-context` and `/dialpad-call` (domain-separated by JWT audience). Retired when Phase 3 lands. |
| `ACCESS_AUD_MIDDLEWARE` | Cloudflare Access App 2 (extension API) audience — the registered redirect URI(s) for App 2's SaaS-OIDC client (comma-separated), **not** an AUD tag (SaaS-OIDC apps have none). Set (live). When unset, the JWT path in `src/auth-extension.js` fails closed — only the legacy `X-Extension-Token` path authenticates. See `docs/security.md` § Application registrations. |
| `ACCESS_CLIENT_ID_MIDDLEWARE` | App 2's SaaS-OIDC `client_id` — used to construct the per-app issuer URL (`${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${ACCESS_CLIENT_ID_MIDDLEWARE}`) during JWT validation. Set (live); must be present alongside `ACCESS_AUD_MIDDLEWARE` or the JWT path falls back to legacy. |
| `INTERNAL_SECRET` | Shared secret for service-binding `POST /internal/calls/upsert` on cache-worker (main worker sends this as `X-Internal-Token`; must match the value set on cache-worker) |

#### MCP worker — `rf-mcp-remote`

| Secret | Used by |
|--------|---------|
| `ACCESS_AUD_MCP` | Cloudflare Access AUD for `rf-mcp-remote`. 64-char hex tag from the App 1 dashboard. |

#### Cache worker — `rf-mcp-cache-sync`

| Secret | Used by |
|--------|---------|
| `RF_API_KEY` | RF API (`RF-Api-Key` header) — independent secret from the main worker's |
| `DIALPAD_API_KEY` | Dialpad API (`Authorization: Bearer`) — for `listDialpadCalls` / `listDialpadCallsPage` in `dialpad-list-client.js` |
| `ADMIN_SECRET` | `X-Admin-Token` for `POST /admin/full-rebuild` and `POST /admin/cache-rebuild` (timing-safe compare) |
| `INTERNAL_SECRET` | `X-Internal-Token` for `POST /internal/calls/upsert` (service-binding endpoint; same value must be set on both main worker and cache worker) |

### Test bindings (in `vitest.config.js` / `vitest.config.ts`, never deployed)

`vitest.config.js`'s `poolOptions.workers.miniflare.bindings` provides non-secret stand-ins for `LINKEDIN_EXTENSION_SECRET`, `RF_API_KEY`, `DIALPAD_API_KEY`, `DIALPAD_WEBHOOK_SECRET`, and `ACCESS_TEAM_DOMAIN` so e2e tests can hit the worker (and mint valid Dialpad webhook JWTs / Access JWTs) without real credentials. Sister configs in `cache-worker/vitest.config.js` and `mcp-remote/vitest.config.ts` do the same for those workers' bindings (in particular, the MCP worker's tests inject a fixture-derived `ACCESS_AUD_MCP` and an RSA-keypair JWKS via `_setJwksForTests`). `wrangler.jsonc` is intentionally clean of secret values to avoid overwriting Cloudflare-managed production secrets on deploy.

### Vars (in `wrangler.jsonc` / sister configs)

| Var | Default | Set on |
|-----|---------|--------|
| `DIALPAD_API_BASE_URL` | `https://dialpad.com/api/v2` | main worker |
| `RF_API_BASE_URL` | `https://api.recruiterflow.com/api/external` | main worker, cache worker |
| `ACCESS_TEAM_DOMAIN` | `https://example-team.cloudflareaccess.com` | main worker, MCP worker |
| `CRON_THIN_ENABLED` | `"true"` (set 2026-05-12) | cache worker | Feature flag enabling `tailSyncThin` during dual-write cutover; currently `"true"` in `wrangler.cache.jsonc`. Code-level fallback is `"false"` when unset. No deploy required to toggle — edit var + redeploy, or use `wrangler secret put`. Remove after cutover step 6. |

### KV namespace

`SYNC_STATE` — single namespace for both debounce flags and candidate cache.
- Production ID: `REDACTED_KV_NAMESPACE_ID`
- Preview ID: `REDACTED_KV_PREVIEW_NAMESPACE_ID`

Bound on the main worker (read+write) and the cache worker (read+write — shared rate-limit / sync-state writes only; the candidate/index cache is main-worker-owned).

### D1 databases

| Binding | Database name | Owner | Migrations |
|---------|---------------|-------|------------|
| `RF_MCP_CACHE` | `rf-mcp-cache` | cache worker (writer); main worker (reader); cache worker also binds `USERS_DB` read-only | `cache-worker/migrations/` |
| `USERS_DB` | `rf-users` | main worker (writer via migrations); cache worker binds read-only for `listConsultants` | `migrations/` (root) |

### Durable Object

`EXT_CALL_STATE` (class `ExtCallState`) — main worker only. Migration tags v1/v2/v3 documented above.

---

## Deployment

- **Auto-deploy**: Push to `master` triggers deployment via the GitHub integration. Each Worker has its own watch-path config:
  - Main worker (`rf-dialpad-sync-dev`) — root + `src/` + `migrations/` + `wrangler.jsonc`
  - Cache worker (`rf-mcp-cache-sync`) — `cache-worker/` subtree
  - MCP worker (`rf-mcp-remote`) — `mcp-remote/` subtree
- **Manual**: `npm run deploy` in each worker's directory.
- **Worker names** — the `-dev` suffix on the main worker is intentional; it's the live production URL and is what the integration webhooks point at.
