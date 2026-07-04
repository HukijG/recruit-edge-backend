# CLAUDE.md

Project rules, conventions, and gotchas for Claude Code. **Architectural detail (data flows, endpoint tables, KV schema, file map) lives in dedicated docs — see "When to read more" at the bottom.** Do not duplicate that material here.

## Project shape

- **Single-tenant, single-worker.** One Cloudflare Worker (`rf-dialpad-sync-dev`) serves production. The `-dev` suffix is the live URL — webhooks point to it. There is no env split, no separate prod worker.
- **Internal tooling for a small team.** Avoid over-abstraction. Hardcoded values (e.g. `DIALPAD_COMPANY_ID`) are fine for single-tenant use.
- **Cache worker is an isolated subtree** (`cache-worker/`) with its own `wrangler.jsonc`, deployed independently via the GitHub build watch path. Runs the cron tail-sync (every 15 min) and the admin-triggered full rebuild Workflow.
- **MCP worker is an isolated subtree** (`mcp-remote/`) with its own `wrangler.mcp.jsonc`, deploys as `rf-mcp-remote`. Stateless Streamable-HTTP MCP server using `createMcpHandler` from `agents/mcp`; service-binding to `rf-dialpad-sync-dev` for the inner `/mcp/*` API.

## Hard project rules (do not violate)

- **Design complete features durably — no "v1 / MVP / iterate-later" scoping.** Frame scope choices as concrete A-vs-B tradeoffs (two complete designs of different shape), not "minimal now, more later." YAGNI applies only to features nobody asked for, never to integral parts of what was described.
- **RF is the source of truth for candidates.** Candidates are always created in RF first; Dialpad contacts derive from RF. **Never create RF candidates from Dialpad data.**
- **Dialpad → RF is update-only** (email, phone, LinkedIn). Dialpad "Created" events are ignored — they're echoes of RF → Dialpad sync.
- **Loop prevention via KV debounce flags.** Both directions write a flag after sync; the opposite direction checks before proceeding (60s TTL).
- **D1 ownership.** The cache worker is the ONLY writer of `RF_MCP_CACHE` (and `mcp:*` KV); main worker reads only — with one documented exception: main worker → cache-worker `POST /internal/calls/upsert` via the `SYNC_WORKER` service binding (requires `X-Internal-Token: env.INTERNAL_SECRET` on both workers). The separate `USERS_DB` D1 is owned by the main worker (writes via migrations). `STAGE_EVENTS` (database `rf-stage-events`, the stage-movement event log) is also owned read+write by the main worker — runtime writes via the idempotent stage-stats upsert, schema via `migrations-stage-events/`. See `docs/security.md` § `POST /internal/calls/upsert` and `docs/stage-stats.md`.
- **Cache-worker cron is additive-only.** Cron runs `*/15 * * * *`. `tailSyncThin` (INSERT-OR-IGNORE into thin tables `candidates_v2`/`jobs_v2`/`calls`, NEVER UPDATE) is **the only path that runs** — gated by `CRON_THIN_ENABLED='true'` (current default in `cache-worker/wrangler.cache.jsonc`, flipped on 2026-05-12 as cutover step 5). Legacy `tailSync` (writes to `candidates`/`candidate_jobs`/`jobs`/`job_pipelines` via INSERT-OR-REPLACE) is gated by `CRON_LEGACY_ENABLED='false'` (default) and intentionally inert — it drove the ~1M D1 writes/day storm the redesign exists to fix. After cutover step 6 drops the legacy tables + code, both gates become redundant. See `docs/security.md` § "Cron re-enable scope" + `docs/architecture.md` § "Cache worker".
- **Extension matching is RF-first, not cache-first.** Reconcile after — never trust the cache for new-candidate matching.
- **MCP mental model: Claude has names, not IDs.** All alias / fuzzy / acronym resolution is server-side. Do **not** add client-side normalisation; if a query is hard to resolve, expand the resolver.
- **Lean MCP envelopes are a contract, not a default.** Never put full bodies in disambiguation responses; cover the 95% case with minimum identifying fields.
- **Every user-facing endpoint goes through Cloudflare Access OAuth. No exceptions.** Any route a teammate hits via browser, AI client, or extension is user-facing. Identity is the verified email claim from the Access JWT, resolved server-side via `getUserByEmail(env, email)` — never accept identity from request bodies. Don't add new shared-secret headers, parallel auth schemes, or new IdP integrations. Webhooks (Dialpad / RF incl. stage-moved / Krisp / calendar) are NOT user-facing; they keep their existing auth. Machine-to-machine stats routes (`/stats/stage-aggregate`, `/admin/stage-stats/*`) are gated by the timing-safe `X-Stats-Token` per the same convention. Service-binding traffic between workers is trusted within the account boundary. **Read [`docs/security.md`](docs/security.md) before adding/touching any user-accessible endpoint.**
- **Observability — LaunchDarkly via OTel.** Every entry handler must set `flow.name` via `trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.X)`. New endpoints add a constant to `src/lib/flow-names.js` (or the equivalent in sync/mcp/poller). Webhook-shaped handlers also set `rf.event_type` / `dialpad.event_type` after payload parse (drives Dashboard 4 panels). Cross-trace continuity via service binding is automatic; async-kickoff patterns use `makeAsyncCallbackUrl` + `readInboundTraceLink` from `src/lib/trace-link.js`. Head sampling is path-conditional via `PathRatioSampler` in `src/lib/otel-config.js` — high-volume polling routes (e.g. `/extension-call-status` at 10%) drop at root-span time so child spans are never created; add new high-volume routes to `PATH_SAMPLING_RULES` rather than re-rolling per-call. Two runtime kill switches via secrets, no redeploy: `LOG_NO_BODY=1` (strip body content only) and `OTEL_DISABLED=1` (cut emission wholesale — emergency lever).
- **Workers AI — banned outside `runAI(env, modelName, input, options?)`.** Direct `env.AI.run` calls are not allowed.
- **Workflows — manually instrumented.** Each Workflow class wraps `run()` in `tracer.startActiveSpan(...)` with `flow.name` + `workflow.id` attributes, and `step.do()` bodies go through `instrumentedStep(step, tracer, instanceId)`. Cache-worker's `bootstrap-otel.js` exposes a Workflow-LOCAL `BasicTracerProvider` via `getWorkflowTracer()` — it deliberately does NOT register globally (would collide with @microlabs's `WorkerTracerProvider`). The Workflow body MUST `await flushWorkflowSpans()` + `await flushLogs()` in `finally`. Caveat: because the provider isn't global, `trace.getActiveSpan()` from outside the tracer scope (e.g. inside auto-instrumented fetch via `globalThis.fetch` body-capture) returns NoOp in Workflow context — instrument inner fetches with explicit `console.log` records for visibility.
- **Where observability lives.** LaunchDarkly project `rf-dialpad-sync`; alerts go to a configured alerting channel. Dashboards are built via the LD Observability MCP — specs in `docs/observability.md` § Dashboards: Billing — Month to Date, Workers, D1, KV · DO · AI, Webhooks, Flows. Alerts pending (UI-only — the MCP has no alert tools). Runbooks: `docs/observability-runbooks.md`.

## Hard API gotchas

- **RF `/candidate/update` REPLACES arrays** (email, phone, tags) — does not append. Always GET first, merge, send the complete array back.
- **Dialpad sends numeric IDs** (`target.id`, `contact.id`) in call webhooks. Always `String()` before `.match()` / comparison.
- **Workers AI may return response as object or string.** `env.AI.run()`'s `response.response` field can be parsed object or JSON string — check `typeof` before parsing/regexing.
- **Dialpad uses Bearer auth** in the `Authorization` header (their recommended path; not the legacy `?apikey=` query string).
- **RF webhooks are slow to register** (~2h after a candidate edit) but fast to deliver. The 60s KV debounce TTL is sized for delivery speed, not registration delay.
- **RF `/candidate/list` has NO cursor pagination.** Only offset (`current_page` + `items_per_page`). Use `/candidate/search` with `added_on` date filter for tail-sync — see `cache-worker/src/rf-list-client.js` `fetchCandidatesAddedSince` for the cap-aware MIN-advance pattern.
- **RF `/candidate/search` has NO `disqualified` boolean filter.** To filter for disqualified candidates: `{key: 'stage', conjunction: 'in', values: ['Disqualified']}`.
- **Dialpad `/v2/call?started_after=…` is strict GT** (not GTE). The 6-hour overlap window in cron tail-sync absorbs this; INSERT-OR-IGNORE on `call_id` PK dedups.

## Validation invariants

- RF candidate must have name (first+last or combined), organization, AND title to sync to Dialpad. Missing any → silently skipped.
- The Dialpad webhook subscription is **org-wide** (no `target_id` filter). Per-user filtering happens server-side via `getUserByDialpadId`. **Adding a consultant is a `src/users.js` edit only — no Dialpad-side per-user step.**

## Cache only immutable

**Cache only immutable (or near-immutable) data in D1.** Mutable fields (email, phone, current_title, current_organization, lead_owner, stage, etc.) are NOT cached — read live from RF on every request. The thin-cache tables (`candidates_v2` / `jobs_v2` / `calls`) hold id + name + linkedin + added_time + snapshot fields only. Mutable filters route to RF `/candidate/search` per the filter-source-of-truth map (see `docs/mcp-middleware.md` § "Filter source-of-truth map"). KV cache (LinkedIn slug → RF id, etc.) stays untouched — it serves the LinkedIn extension hot path and is updated by webhook handlers.

## Single sources of truth

- **`src/users.js` is THE team registry — D1-backed (`USERS_DB`).** All public lookups async, take `env` as first arg, return from a module-level cache. Adding/updating teammates = new `migrations/` SQL + `wrangler d1 execute --remote`. **Do NOT hardcode emails / RF user ids / Dialpad ids in source code.** See `docs/security.md` for the auth flow + helper signatures.
- **Active Dialpad `call_id` per consultant lives in the `ExtCallState` Durable Object, not KV.** KV's cross-PoP eventual consistency caused visible polling lag — the DO gives strict read-after-write. The Dialpad `calling`+`hangup` webhook (`/webhook/dialpad/extension-calls`) is the **only** writer. `/dialpad-call`, `/dialpad-hangup`, `/extension-call-status` never write the DO.
- **Cold-call contacts are pre-linked.** The LinkedIn extension creates the Dialpad contact with name + RF UID in one shot, so call-transcript webhooks always have an RF id available. Calls without an RF id are skipped — no deferred processing needed.
- **D1 thin tables are the authoritative local cache.** `candidates_v2`, `jobs_v2`, `calls` (in `RF_MCP_CACHE`) are the canonical D1 cache. Immutable / quasi-immutable fields only — never mutable data. See `docs/architecture.md` § D1 schema.

## Cache freshness invariant

Every RF, Dialpad, and calendar webhook updates the KV candidate cache. The cache is the first port of call for lookups by LinkedIn, email, or name when no RF ID is available. **If you add a write path, you must also update the cache** — otherwise lookups silently go stale.

## Commands

```bash
npm run dev    # Local dev (wrangler dev)
npm test       # Vitest
```

Deployment is automatic via GitHub on push to `master`. Secrets are managed via the Cloudflare dashboard — never put them in `wrangler.jsonc`.

---

## Docs structure (canonical)

- **`docs/` root** — LIVE docs describing the current state. `architecture.md` (cross-cutting integration), `security.md` (auth), `mcp-middleware.md` (MCP layer). After implementing a feature that touches one of these spheres, **update the doc**. After introducing a brand-new sphere (new worker, big new feature), **create a new live doc**.
- **`docs/references/`** — commonly-used external API contracts (RF webhook payload examples, etc.).

**End-of-implementation audit:** when the user explicitly confirms a feature is shipped/tested/happy, retire the working spec/plan notes, delete scratch screenshots, update any moved-doc pointers in CLAUDE.md / live docs.

## When to read more

These are the live reference docs. **Do NOT load by default — read on demand based on the task.**

- **Any sync flow, endpoint, file map, KV cache key, D1 schema (including thin tables `candidates_v2`/`jobs_v2`/`calls`), env var, or RF/Dialpad API pattern**
  → `docs/architecture.md` (full data flows for RF↔Dialpad, Calendar, Krisp, cold-call detection, extension routes, cache worker, MCP worker; endpoint tables; source-file map; KV + D1 schemas; DO migration history; extension caching strategy; loop prevention; deployment)

- **Anything under `/mcp/*` — middleware endpoints, fuzzy resolvers, tool descriptors, filter source-of-truth map, live-fetch pipeline reads, thin-vs-expanded hydration, custom-field universe handling, design conventions for new tools**
  → `docs/mcp-middleware.md` (canonical, current)

- **Auth (Cloudflare Access + OTP) and any user-facing endpoint work**
  → `docs/security.md` (canonical — convention for new endpoints, current state, env vars, helper signatures, what's pending)

- **The stage-movement stats plane — the stage-moved webhook, STAGE_EVENTS D1, the weekly CV/IV aggregate, the dashboard push/pull contracts, reconcile/backfill ops**
  → `docs/stage-stats.md` (canonical sphere doc)

- **Anything about observability — `flow.name`, body capture, OTel SDK setup, dashboards, alerts**
  → `docs/observability.md` (live doc) and `docs/observability-runbooks.md`.
