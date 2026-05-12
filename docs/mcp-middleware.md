# MCP Middleware

Server side of the MCP layer. A thin router (`src/mcp/router.js`) under `/mcp/*` resolves the consultant from a verified Access JWT (`consultantEmail` body field, forwarded over the service binding from `rf-mcp-remote` — see `docs/security.md`), then dispatches to per-tool middleware handlers in `src/mcp/`. Read-only against a shared D1 cache (`RF_MCP_CACHE`). Pipeline data is **not cached** — every `job-pipeline` / `job-candidates-filter` read goes live to RF (see § Pipeline reads below). Cron is gated behind two env vars: `CRON_THIN_ENABLED='true'` (set 2026-05-12 as cutover step 5 — the active additive path) and `CRON_LEGACY_ENABLED='false'` (legacy path inert until cutover step 6 drops it). Both fall back to `'false'` in code when the var is unset. See `docs/architecture.md` § Cache worker.

The `rf-mcp-remote` MCP worker (`mcp-remote/`) is the public Streamable-HTTP front; it validates the Access JWT, then service-binds into this `/mcp/*` surface. Architecture overview in `docs/architecture.md`. Auth shape in `docs/security.md`.

## Mental model

Claude never has ids — it has names. The middleware does ALL alias / fuzzy / acronym resolution server-side. The MCP worker is a transparent forwarder that injects the verified `consultantEmail` (from the Access JWT) and returns the JSON verbatim. **Do NOT add client-side normalisation on the consumer.** If a query is hard to resolve, expand the resolver, not the consumer.

## Design conventions for new MCP tools

Every new MCP tool / endpoint added to either worker follows these rules. They are not stylistic preferences — they exist for prompt-budget economy, single-round-trip UX, and mental-model coherence. **Read this section in full before designing or implementing any new tool.**

### Re-use entity resolvers; never roll your own

Candidate / job / stage / owner references go through `src/mcp/resolvers.js`. Use:

- `resolveCandidate(env, input)` — numeric short-circuit OR fuzzy via the in-memory snapshot.
- `resolveJob(env, input, { restrictTo, onlyOpen, validateNumeric })` — fuzzy against the `jobs` table, defaults to open-only; pass `restrictTo: nonDq` for candidate-scoped flows (move-stage / log-interview / add-note).
- `resolveStage(input, stages)` — fuzzy against a job's `stages[]` array.
- `resolveOwner(env, input)` — `users.js` fast path → `sync_state.users` fallback.

Each resolver returns one of:
- `{ok: true, value}` — unique match
- `{ok: false, reason: 'ambiguous', kind, options, hint}` — too close to call
- `{ok: false, reason: 'not_found', input}` — no match

The ambiguity envelope shape is consistent across all four resolvers so handlers can pattern-match a single shape.

**Do NOT add client-side normalisation on the consumer.** If a query is hard to resolve, expand the resolver. If a fuzzy field needs a new alias path (e.g. an acronym map), put it server-side in `fuzzy.js` / `resolvers.js`.

### Lean tool definitions — `mcp-remote/src/tools.ts`

For each `server.registerTool(...)` block:

- Input schema is the minimum identifying fields. Use `ref = z.union([z.string(), z.number().int()])` for entity references that accept either fuzzy names or numeric ids.
- `*_id` short-circuit fields are accepted by the middleware handler but are NOT advertised in the tool's input schema. Numeric short-circuit happens transparently because `resolveCandidate` / `resolveJob` detect digit-strings.
- Write tools never expose an attribution-override field (`user`, `created_by`, `activity_user_id`, etc.). Attribution is always `consultant.rfUserId` resolved from the JWT — server-side, no surface.
- Description prose says: what to use the tool for, what fuzzy resolution means in this context, what disambiguation looks like, what recoverable failures look like, and that attribution is JWT-locked. Read existing tool blocks for the canonical phrasing.

### Lean responses — the contract

Response shapes consume tokens in Claude's context. Every byte must justify itself by carrying information Claude does NOT already have.

**Success on write tools** is literally "this happened" — no echoing back what Claude sent:

| Tool | Success shape | Rationale |
|---|---|---|
| `rf_candidate_add_note` | `{ok: true}` | Claude has the candidate identity from the request; the RF note id is not used downstream. |
| `rf_candidate_move_stage` | `{ok: true, moved: {candidate_id, candidate_name, job_id, job_name, from_stage, to_stage}}` | `moved` carries the resolved tuple when auto-narrow picked from several possibilities — information Claude does NOT have from the request alone. |
| `rf_candidate_log_interview` | `{ok: true, activity: {id, candidate_id, kind}, next_step, outlook_url, gcal_hint?}` | Calendar handoff payload is the whole reason the tool exists. |

Bias toward `{ok: true}` for write tools. Only include extra fields when Claude cannot reconstruct them from the request OR they are load-bearing for a follow-up action (like calendar handoffs).

**Disambiguation envelope** at HTTP 200:

```json
{ "needs_disambiguation": true, "kind": "candidate"|"job"|"stage"|"owner", "options": [...], "hint": "..." }
```

`options[]` carries ONLY the minimum identifying fields per option (candidates → `{id, name, current_organization, current_title}`; jobs → `{id, name, client_company_name}`; etc.). Never put full record bodies in `options`. If consumers need richer context, they re-call with the chosen id against `rf_candidate_get`.

**Recoverable failures** at HTTP 200:

```json
{ "ok": false, "kind": "...", "error": "...", "available_jobs"?: [...], "available_stages"?: [...] }
```

Short error string + recovery hints only where they would unblock the caller. Hints are themselves lean — names + ids, no full bodies.

**Loud failures (4xx / 5xx)** are install / transport errors only. Never use these as a routing mechanism for user-facing recovery cases (those go through the `{ok: false, kind, error}` shape above).

**No echo.** Never include in the response what Claude sent in the request. Claude already has it.

### Handler shape — post-narrow

New handlers follow the post-narrow shape of `src/mcp/candidate-log-interview.js` (or `candidate-add-note.js`):

1. **ID short-circuit.** Coerce `*_id` body fields onto the fuzzy field (`body.candidate_id` → `body.candidate`).
2. **Validation.** Required fields present (else 400 with exact short error string).
3. **Candidate resolve.** `resolveCandidate(env, body.candidate)` → single / ambiguous (load top-K bodies via `getCandidateById`) / not_found.
4. **Optional `job` filter.** Drop candidates without a non-DQ link to the requested job via `resolveJob(env, body.job, { restrictTo: nonDq })`.
5. **0 survivors** → 400 with a precise error string.
6. **>1 survivors** → standard `needs_disambiguation` envelope at HTTP 200.
7. **1 survivor** → commit + return lean success.

If a new tool genuinely does NOT fit this shape, justify it in the spec doc — do not silently diverge.

### Internal helpers — expose for in-process reuse

Every handler module exposes a "do the thing" function as a named export. The function accepts the already-resolved candidate (and consultant) and returns the same `{ok, ...}` envelope the HTTP handler emits. Example: `addNoteForCandidate({env, candidate, noteMd, consultant})` returning `{ok: true}` / `{ok: false, status, error}`.

Future tools that orchestrate multiple write actions (e.g. a Dialpad-call-to-note tool that combines a Dialpad lookup with a note write) MUST call these helpers in-process — no service-binding round-trip back into `/mcp/*` for work that lives in the same worker.

### Summary checklist

When adding a new tool, the spec / plan / implementer must each be able to point to:

- [ ] Resolver reuse (no client-side normalisation, no rolled-own fuzzy)
- [ ] Lean input schema (no `*_id` advertised; no attribution override)
- [ ] Lean success shape (`{ok: true}` unless extra fields are load-bearing — say why in the spec)
- [ ] Standard disambiguation envelope (minimum identifying fields per option)
- [ ] Standard recoverable-failure shape (`{ok: false, kind, error}` at HTTP 200)
- [ ] Post-narrow handler shape (or justification for divergence)
- [ ] Internal helper exposed for in-process reuse

If you cannot tick all seven, the design is not ready to ship.

## The two-worker split

| Worker | Role |
|---|---|
| **Main worker** (`rf-dialpad-sync-dev`) | Reader. Serves `/mcp/*`. Reads D1. **Never writes.** |
| **Cache worker** (`cache-worker/`, isolated subtree, own `wrangler.jsonc`, deployed independently via GitHub build watch path) | Sole writer. Runs the cron tail-sync (every 15 min) and the admin-triggered full rebuild Workflow. **Sole writer to D1.** |

> **Discipline rule: no main-worker code path may write D1.** That invariant keeps the sync surface auditable and prevents schema drift between writers.

## Storage

**D1 binding** `RF_MCP_CACHE` is shared between both workers (sync writes, main reads). Schema across migrations in `cache-worker/migrations/`:
- `candidates`, `candidate_jobs`, `jobs`, `sync_state` — `0001_init.sql`
- `job_pipelines` — `0002_job_pipelines.sql` (per-job pipeline snapshot, legacy; no longer consulted by any MCP handler — scheduled for removal at cutover step 6)
- `candidates_v2`, `jobs_v2`, `calls` — `0003_v2_tables.sql` (thin schema; additive-only writes; INSERT-OR-IGNORE on PK only)

`candidates_v2` stores thin rows `{id, name, linkedin_profile, added_time_ms, current_title_at_cache_time, current_company_at_cache_time, cached_at_ms}` — the source for the in-memory snapshot and D1 batch hydration. The old `mcp:pipeline:{jobId}` and `mcp:job-candidates:{jobId}` KV keys are gone; the `job_pipelines` D1 table is scheduled for removal at cutover step 6 (`0004_drop_legacy.sql` in `cache-worker/migrations-pending/`); MCP pipeline reads no longer consult it — they go live to RF.

Tail sync inserts newly-added candidates into `candidates_v2` and `calls` via INSERT-OR-IGNORE (additive only; no UPDATEs). Version key `last_candidates_added_cursor` in `sync_state` gates snapshot refreshes (falls back to `last_tail_sync_at` during the dual-write transition window).

## Auth

- `/mcp/*` (main worker) accepts only service-binding traffic from `rf-mcp-remote`. Identity arrives as the `consultantEmail` body field; no shared-secret header. `MCP_EXTENSION_SECRET` was retired 2026-05-10. See `docs/security.md` for the JWT validation flow.
- A transitional `consultantFirstName` body fallback survives in `src/mcp/router.js` for legacy local-MCP installs; it logs `[mcp] legacy consultantFirstName fallback` and is dropped at the auth Phase 3 cutover.
- `ADMIN_SECRET` — cache worker only, in `X-Admin-Token` header for `POST /admin/full-rebuild`. Internal admin path; not user-facing.

## Entity-reference resolvers

`src/mcp/resolvers.js` — every endpoint that takes a `candidate`, `job`, `stage`, or `owner` reference accepts EITHER a numeric id (or digit-string) OR a fuzzy name.

- Names go through the same `fuzzy.js` scorer the search endpoint uses
- Jobs additionally fold acronyms via `canonicalizeJobPhrase` ("Eon SE" ↔ "Eon Sales Engineer")
- Owners hit `users.js` first (fast path for the team) then fall back to `sync_state.users` (cached RF user list)
- On ambiguity, every endpoint returns the same lean envelope:
  ```json
  { "needs_disambiguation": true, "kind": "candidate"|"job"|"stage"|"owner", "options": [...], "hint": "..." }
  ```

> **Lean is a contract, not a default** — never add full bodies to disambiguation; cover the 95% case with the minimum identifying fields and let consumers follow up with `candidate-get` if they need more.

### ID short-circuit

Every endpoint that accepts a `candidate` / `job` / `stage` / `owner` reference also accepts a corresponding `*_id` body field. When present, the `*_id` field bypasses fuzzy resolution entirely — direct row lookup. This is the deterministic path for follow-up turns where Claude has the ID from a prior response.

| Endpoint | Short-circuit fields |
|---|---|
| `/mcp/candidate-get` | existing `id` field (no change) |
| `/mcp/candidate-search` | `job_id`, `owner_id` |
| `/mcp/candidate-move-stage` | `candidate_id`, `job_id`, `stage_id` — when ALL THREE present, fast-path direct commit |
| `/mcp/candidate-log-interview` | `candidate_id`, `job_id` |
| `/mcp/candidate-add-note` | `candidate_id`, `job_id` |
| `/mcp/candidate-call-notes` | `candidate_id` (step=submit_notes — fast path that bypasses fuzzy resolve; the fuzzy fallback uses `candidate_fallback` instead) |
| `/mcp/job-pipeline` | `job_id` |
| `/mcp/job-candidates-filter` | `job_id` |

When a `*_id` field is present, the corresponding fuzzy-name field (`candidate`, `job`, etc.) is ignored — no double-pass, no merge.

### Fuzzy job scope

`resolveJob` defaults to **open jobs only** (`is_open=1`). Closed jobs are excluded from fuzzy scoring entirely; recruiters reach a closed job only by passing an explicit numeric id. The `restrictTo` path (move-stage / log-interview against a candidate's own jobs[]) ignores `onlyOpen` since the universe is already constrained.

### Two-phase resolver — Phase 1 (cache) + Phase 2 (live RF)

The candidate/job resolvers run in two phases. **Phase 1** scores against the thin in-memory snapshot (`candidates_v2` / `jobs_v2`) using `scoreString` (prefix-exact, word-boundary substring, per-token Levenshtein on tokens ≥ 4 chars, extension-word penalty, equal-length bonus). **Phase 2** fans out to live RF (`/candidate/get` or `/job/get`) for the Phase 1 top-K to read mutable fields — `is_open` for jobs, `jobs[].stage_moved` (filtered to non-Sourced / non-Disqualified stages) for candidates — that intentionally aren't cached.

Phase 2 fires whenever Phase 1 can't auto-resolve confidently. Auto-resolve requires `top.score >= 0.92` AND `top.score - second.score >= 0.08`. Anything else fans out the top 5 via `pMapLimit` concurrency 5 (~150–300 ms total). Per-id fan-out failures degrade gracefully — the row keeps its Phase 1 score with a `_phase2: 'fetch_failed'` marker, so a transient RF blip doesn't drop a real match.

The recency signal lives entirely in Phase 2. The previous `added_time_ms` recency boost on the cache path was actively harmful — hundreds of candidates added weekly all enter Sourced, so the boost flooded top results with newly-sourced rows and deranked re-engaged candidates already in the CRM. `stageRecencyBoost` in `live-rerank.js` reads `jobs[].stage_moved` for non-inert stages (Sourced and Disqualified are inert), decays linearly over a 60-day window, caps at +0.25. When no eligible stage exists the candidate gets 0 boost — that's the correct answer for a candidate who hasn't been touched beyond auto-sourcing.

`resolveJob` skips Phase 2 when `restrictTo` is set (candidate's own jobs[] is already a closed list — a live RF fan-out adds latency without changing the answer).

`candidate-search` runs the same Phase 1 + Phase 2 split on the pure-fuzzy path (`hasQuery && !hasMutableFilters`). Phase 2 fan-out is capped at PHASE2_FANOUT (5) regardless of caller-supplied `limit`; larger limits get Phase 2 rerank on the top 5 and the tail keeps Phase 1 ordering. Tier-2 paths (mutable filter present) skip Phase 2 — RF's own filter narrowing is the source of truth.

**Cache invariant.** The whole point of Phase 2 is to keep `is_open` / `stage_moved` OUT of the thin D1 cache. Adding either to `candidates_v2` / `jobs_v2` is a regression — the cron write-storm fix exists exactly because those fields update too often to cache cheaply. Phase 2 reads them live at disambiguation time, paid only when Phase 1 can't decide alone.

### Score floors (prefix-exact ≫ Levenshtein)

The score formula has two floors load-bearing for first-name matching:

- **Prefix-exact**: `0.85 + 0.10 * coverage - extraPenalty`. Floor 0.85 (was 0.7).
- **Levenshtein per-token fallback**: `0.55 + 0.10 * (levSum / qTokens.length)`. Ceiling 0.65 (was 0.75).

The gap is intentional. The prior values let a Levenshtein near-miss like "Ferry" (one edit from "Jerry") reach ~0.75; combined with the max recency boost (×1.2) it could top ~0.9 and beat a prefix-exact "Jane Doe" stuck at ~0.775. A recruiter typing "jerry" got name-look-alikes ranked above actual Jerrys whenever the look-alikes happened to be more recent (observed in the 2026-05-12 smoke test). The rebalancing guarantees a stale prefix-exact match still outranks the freshest Levenshtein near-miss.

### RF canonicalisation (live-fetch field names)

RF's `/candidate/get` and `/candidate/search` return field names that don't match the canonical MCP projection vocabulary:

| RF wire field         | Canonical name used by MCP defaults / projection |
|-----------------------|--------------------------------------------------|
| `email: [...]`        | `primary_email` (first), `emails` (preserved)    |
| `phone_number: [...]` | `phone_numbers`                                  |
| `current_designation` | `current_title`                                  |
| `jobs[].name`         | `jobs[].job_name`                                |

`src/rf-canonical.js` exports `canonicalizeRFCandidate(rf)` — an **additive** transform that sets the canonical names when they're missing and never overwrites existing keys. It runs at the `src/rf-client.js` integration boundary inside `getRFCandidate` and `searchCandidatesByFilters`, so every MCP consumer (candidate-get, candidate-search tier-2, job-pipeline + job-candidates-filter expanded-hydration, and the per-tool `getRFCandidate` fan-outs in candidate-log-interview / candidate-add-note / candidate-move-stage) reads canonical names regardless of RF's wire shape drift. Raw RF fields stay in the body verbatim — non-MCP consumers (`src/cold-call.js`, `src/index.js` extension flow) that still read `email` / `phone_number` continue to work.

The cache-worker's `cache-worker/src/normalize.js` `toCandidateRow` / `toCandidateThinRow` builders do the same shape mapping before writing to D1; the canonicaliser is the parallel transform for the live-fetch path that bypasses D1.

### Post-narrow disambiguation on writes

`candidate-move-stage`, `candidate-log-interview`, and `candidate-add-note` enumerate every valid candidate (and `(candidate, job, stage)` tuple where relevant) and only ambiguate when ≥2 valid options remain.

- When candidate is fuzzy-ambiguous but only one match has the requested job/stage → worker auto-commits, no round-trip.
- When ≥2 tuples remain → `kind` is the smallest level of variation (candidates differ → `candidate`, same candidate but jobs differ → `job`, etc.) and options carry just enough tuple context to disambiguate at that level.

`candidate-call-notes` step=list_calls uses the same standard `needs_disambiguation` envelope when the fuzzy candidate name resolves to multiple options; its step=submit_notes fallback path delegates to `candidate-add-note` so the disambiguation semantics are identical.

### Stage resolution coverage

`stage` is fuzzy on every endpoint that accepts it:
- `candidate-move-stage` (against the target job's `stages[]`)
- `candidate-search` (against distinct `stage_name` values from `candidate_jobs` for the resolved job)
- `job-pipeline` and `job-candidates-filter` (against the live `summary[]` returned by RF `/job/pipeline`)

Ambiguity returns the standard envelope; not_found on the read-side endpoints falls through to literal exact-match (so unknowns still return empty results, never 404).

### Custom-field filter resolution

`technology` (multi-select), `segment`, and `role` filters on `candidate-search` resolve against the canonical option universe from RF's `/candidate/custom-field/list` endpoint. The map is fetched lazily and cached in worker globals for 5 min (`src/mcp/custom-fields.js`).

- Case-insensitivity ("kubernetes" → "Kubernetes") and prefix matching ("ent" → "Enterprise") work out of the box.
- **Synonym mapping (e.g. "k8s" → "Kubernetes") is NOT covered** — for that, add the alias to a future explicit alias dictionary, don't push normalisation onto the consumer.
- After resolving the canonical option name, the filter goes to RF as `{key: 'custom_field.<id>', conjunction: 'in', values: [<name>]}` — same single round-trip pattern as the other mutable filters.
- If RF's `/candidate/custom-field/list` is unreachable (network / 5xx after retry / 429), the response carries `warning: 'custom_field_map_unavailable'` and the offending filter is dropped (the rest of the search still runs). Never silent — every dropped filter generates an observable warning.

## Endpoints

All under `/mcp/*`. Identity is the verified `consultantEmail` body field (forwarded by `rf-mcp-remote` from the Access JWT). No header auth — service-binding traffic is trust-local within the Cloudflare account boundary.

| Endpoint | Purpose |
|---|---|
| `/mcp/cache-status` | Returns sync_state stamps + table counts; cheap health probe. |
| `/mcp/candidate-search` | Fuzzy name match (tier-1, in-memory snapshot) and/or mutable filter (tier-2, single RF `/candidate/search` call). See § Candidate search pattern below. `job` + `owner` accept names via the resolver. `disqualified: true` → RF `stage='Disqualified'` (no boolean DQ filter). |
| `/mcp/candidate-get` | Fuzzy resolve (snapshot) → thin-cache sanity check → live RF `/candidate/get`. Returns full candidate body projected via `fields[]`. `needs_disambiguation` on ambiguous name; `ok: false, kind: 'rf_unavailable'` on RF failure. |
| `/mcp/candidate-move-stage` | Fuzzy-resolves candidate/job/stage, calls RF `/candidate/move-to-stage` attributed to consultant. |
| `/mcp/candidate-log-interview` | Fuzzy-resolves candidate (+ optional job restricted to candidate's jobs); creates RF custom activity (interview activity-type id resolved dynamically from `sync_state.activity_types`); returns `outlook_url` (recruiter-only block — no candidate email on `to=`) and optional `gcal_hint` based on `consultant.calendarMode`. |
| `/mcp/candidate-add-note` | Fuzzy-resolves candidate (+ optional job restricted to candidate's jobs); renders markdown body → HTML via `marked` (in `src/mcp/markdown.js`); calls RF `/candidate/notes/add` attributed to `consultant.rfUserId` from the JWT. No `mentions` resolution, no attribution override. Success returns `{ok: true}` only — no echo back (per the lean-response convention). Exposes an internal `addNoteForCandidate(...)` for in-process reuse. |
| `/mcp/candidate-call-notes` | Three-stage Dialpad-call → structured RF note. `step='list_calls'` fuzzy-resolves candidate + reads from D1 `calls` table via `getCallsForCandidate` (~5-10ms; per-record auth enforced by `target_dialpad_id` in WHERE). `step='get_transcript'` checks `call.target.id == consultant.dialpadId`, fetches `/transcripts/{call_id}`, returns transcript + call-notes rendering brief. `step='submit_notes'` delegates to `addNoteForCandidate` (fast path) or `handleCandidateAddNote` (fuzzy fallback). |
| `/mcp/job-candidates-filter` | Live RF `/job/pipeline` + conditional D1 or RF hydration. Flat (non-grouped) candidate list. `stage` filter (fuzzy against live `summary[]`); `include_disqualified` (default false); `limit` (default 100, max 500); `truncated: true` when total exceeds. On RF failure: `{ok: false, kind: 'pipeline_unavailable'}`. See § Pipeline reads below. |
| `/mcp/job-pipeline` | Live RF `/job/pipeline` + conditional D1 or RF hydration. Stage-grouped pipeline view. Filters: `stage` (single, fuzzy), `from`/`to` (range, fuzzy against live `summary[]`), `submitted: true` (exact match on 'CV Sent' → end of pipeline). Default: same as `submitted`. Disqualified excluded unless `include_disqualified: true`. On RF failure: `{ok: false, kind: 'pipeline_unavailable'}`. See § Pipeline reads below. |

### Three-step Dialpad-call-to-note flow

`/mcp/candidate-call-notes` is the only multi-stage endpoint on the MCP surface. It exists because Claude has to round-trip with the user between stages (which call → user picks one → notes drafted → user accepts → commit), so the natural shape is three separate API calls keyed by a `step` discriminator.

Stages and their data flow:
1. `list_calls`: candidate ref + time window → list of `{call_id, started_at, duration_minutes, direction}`. Candidate ambiguity returns the standard `needs_disambiguation` envelope. Calls are read from the D1 `calls` table via `getCallsForCandidate(env, consultant.dialpadId, candidate.id, opts)` — ~5-10ms; no Dialpad live call. Per-record auth is enforced in the WHERE clause: `target_dialpad_id = consultant.dialpadId`. Filters applied in-query: `duration_ms >= 120000` (default), `date_started_ms BETWEEN startedAfterMs AND startedBeforeMs`, `LIMIT 20`.
2. `get_transcript`: `call_id` → `{candidate, call, transcript, guidance}`. Per-record auth: `call.target.id == consultant.dialpadId` (rejected as `kind: 'not_your_call'` otherwise — Access JWT plus this per-record check is the layered authorization). Fetches live from Dialpad `/transcripts/{call_id}`; filters to `type='transcript'` lines.
3. `submit_notes`: `candidate_id` (fast) OR `candidate_fallback` (fuzzy) plus markdown `note` → `{ok: true}`. The fuzzy path delegates to `handleCandidateAddNote` verbatim.

Full design: the candidate-call-notes design spec (shipped 2026-05-12).

Bundle wiring: the call-notes rendering brief lives in `docs/references/call_notes_guidance.md` and is imported into the worker bundle via wrangler's text-loader rule (`rules: [{type: "Text", globs: ["**/*.md"], fallthrough: false}]`). The glob is broad because wrangler matches it against resolved absolute paths, not project-relative paths — only one source file actually imports a `.md` (`src/mcp/call-notes-guidance.js`), so the broad glob is safe in practice. `fallthrough: false` silences wrangler's "shadowed default rules" warning. Editing the .md and redeploying is the operator's path to update the guidance.

### Default fields

`body.fields` is **additive** — extends the per-endpoint defaults, does not replace them. Unknown field names are dropped silently (no `_meta.unresolved_fields`). Successful alias resolutions are applied silently (no `_meta.notes`).

| Endpoint | Per-candidate defaults |
|---|---|
| `/mcp/candidate-get` | `id, name, first_name, last_name, primary_email, phone_numbers, current_title, current_organization, linkedin_profile, jobs.*.client_company_name, jobs.*.job_name, jobs.*.stage_name` |
| `/mcp/candidate-search` | `id, name, current_title, linkedin_profile` |
| `/mcp/job-pipeline` (per-stage candidate) | `id, name, linkedin_profile` |
| `/mcp/job-candidates-filter` | `id, name, linkedin_profile` |

Notes:
- `fields` extends defaults — does not replace. Unknown field names dropped silently.
- LinkedIn returned as full URL (`https://www.linkedin.com/in/...`) regardless of D1 storage shape (bare slug).

### Adding a new endpoint

**Before starting:** read [Design conventions for new MCP tools](#design-conventions-for-new-mcp-tools) — that section defines what input / output shapes are acceptable. This recipe is the mechanical wiring; the conventions are the contract.

Recipe for a new `/mcp/<name>` endpoint:

1. **Handler.** Create `src/mcp/<name>.js` exporting `handle<Name>({ env, body, consultant })`. Return `Response` via `jsonResponse(status, payload)` from `./router.js`.
2. **Register.** Add to `src/mcp/handlers-registry.js` under the `'/mcp/<name>'` key.
3. **Resolvers.** If the body takes a `candidate` / `job` / `stage` / `owner` reference, use `resolveCandidate` / `resolveJob` / `resolveStage` / `resolveOwner` from `./resolvers.js`. They handle numeric short-circuit + fuzzy + ambiguity envelope. Add a `*_id` body field for deterministic lookups (see "ID short-circuit" above).
4. **Field projection.** If the response carries candidate detail, declare `const DEFAULT_FIELDS = [...]` and project via:
   ```js
   import { resolveFieldsWithDefaults } from './projection.js';
   import { projectWithLinkedIn } from './linkedin.js';
   const { paths } = resolveFieldsWithDefaults(body.fields, DEFAULT_FIELDS, sample, candidate);
   const projected = projectWithLinkedIn(candidate, paths);
   ```
   Defaults always present; `body.fields` extends. LinkedIn slugs auto-normalized to URLs at output.
5. **`_meta`.** Don't emit it on success. If the caller did something they should know about (cold cache, missing landmark, falling back), accumulate `warnings: string[]` and emit `_meta: { warnings }` only when non-empty. Each warning ≤ ~80 chars.
6. **D1 reads.** Use `session(env)` from `./d1-read.js` to get a session-pinned reader (cache-worker writes are read-after-write consistent within the session). NEVER write to D1 from the main worker — that's the cache worker's exclusive responsibility.
7. **Tests.** Add `test/mcp-<name>.spec.js` modeled on the existing specs (e.g. `test/mcp-job-pipeline.spec.js`). Use `import { env, createExecutionContext } from 'cloudflare:test';` and `applyMigration(env)` in `beforeEach`. Identity arrives in the body — pass either `consultantEmail: 'alex@<test-domain>'` (current path) or `consultantFirstName: 'Alex'` (legacy fallback path, exercised by existing specs while it remains wired). The `X-MCP-Token` header is no longer validated; specs that still set it work fine but the header is a no-op.
8. **Consumer surface.** Tool registrations + descriptions live in `mcp-remote/src/tools.ts` (`registerTools`). Add a `server.registerTool(...)` block there with the body params, response shape, and the default field set so the LLM client's tool list reflects the new endpoint. If the new tool is the read endpoint Claude should always have loaded, set `_meta: { "anthropic/alwaysLoad": true }`.
9. **Endpoint table.** Add a row to the table above. If the endpoint adds a new `*_id` body field, add it to the ID short-circuit table too.

If the new endpoint requires data NOT already in D1, that's a cache-worker change — extend the tail-sync writer, not the read path. Read paths must never call RF directly except for the write endpoints (`move-stage`, `log-interview`, etc.) and the pipeline tools (`job-pipeline`, `job-candidates-filter`, `candidate-get`) where it's intentional.

### Candidate search pattern (tier-1 + single RF call)

`/mcp/candidate-search` uses a two-tier pattern to combine fuzzy name matching with mutable RF filters in a single round-trip:

**Filter classification.** Filters split into:
- **Immutable** (`added_after` / `added_before`, `linkedin_profile`) — resolved against the in-memory snapshot or D1; no RF call.
- **Mutable** (`email`, `company`/`current_organization`, `current_title`, `owner`/`lead_owner_id`, `stage`+`job`, `disqualified`, future `custom_field.<id>`) — routed to RF.

**Decision tree:**
1. **Pure fuzzy (no mutable filter)** — tier-1 snapshot scan only; recency-boosted by `added_time_ms`. No RF call.
2. **Immutable filter only (no query, no mutable)** — snapshot scan with in-JS predicate. No RF call.
3. **Fuzzy query + mutable filter** — tier-1 snapshot → id pool (up to 200 ids) → ONE RF `/candidate/search` call with `{candidate_id IN (ids), ...predicateFilters}` intersection server-side. RF failure degrades to tier-1 results with `warning: 'filter_unverified'`.
4. **Mutable filter + no query** — predicate-only RF search (no id list). RF failure → empty result with `warning: 'filter_unverified'`.
5. **Empty tier-1 + mutable filter** — return empty without calling RF.

When both a fuzzy query and a mutable filter are present, tier-1 fuzzy score ordering is preserved on the RF intersection result (RF doesn't preserve fuzzy ordering; the handler re-ranks by score after the RF call).

`disqualified: true` expands to RF `stage='Disqualified'` — RF has no boolean DQ filter. When a `stage` filter is also set, the user's explicit stage takes precedence.

Immutable filters (`added_after`/`added_before`, `linkedin_profile`) are appended to RF calls when a mutable filter is already present (so both sources agree), but do NOT trigger an RF call on their own.

### Pipeline reads (live RF + conditional hydration)

`/mcp/job-pipeline` and `/mcp/job-candidates-filter` are fully live — no D1 pipeline cache.

**Per-request flow:**
1. ONE live RF `/job/pipeline?job_id=<id>` call (~300–800 ms baseline). Returns `{summary: [{id, name, count}], detail: [{candidate: {id, name}, stages: [...]}]}`. `summary[]` is the canonical ordered pipeline (per-job, includes 0-count stages and Disqualified). The "current stage" for each candidate is derived from the most-recent `stages[].to` in `detail[]`.
2. Apply windowing (`stage`, `from`/`to`, `submitted: true`, or default CV-Sent → end). Fuzzy against the live `summary[]`.
3. Conditional per-candidate hydration based on `fields[]`:
   - **Thin (default `['id', 'name', 'linkedin_profile']` or any subset of `candidates_v2` columns)** — one D1 batch via `getCandidatesByIds` (~5-10ms). Columns: `id, name, linkedin_profile, added_time_ms, current_title_at_cache_time, current_company_at_cache_time`.
   - **Expanded (any field requiring live data — `current_title`, `primary_email`, `phone_numbers`, custom fields, etc.)** — parallel `/candidate/get` fan-out at concurrency 8 via `pMapLimit`. Per-id failures captured as `hydration_errors[]` in the response — partial result returned, never a thrown error.

**Latency profile:**
- Thin (default) fields: ~300–810 ms (RF pipeline call + D1 hydration).
- Expanded fields, N candidates in selected stages: ~300–800 ms + ceil(N/8) × ~150 ms.

**Why no pipeline cache:** a cache must be invalidated on every move-stage, disqualification, owner reassignment, and new-candidate-on-job. The bust paths multiply faster than the read savings; 300–800 ms is the cost of correctness.

On RF failure: `{ok: false, recoverable: true, kind: 'pipeline_unavailable', job, error}`.

### Filter source-of-truth map

| Filter | Source | Notes |
|---|---|---|
| `query` (fuzzy name) | Cache snapshot (`candidates_v2`) | Recency-boosted via `added_time_ms` |
| `added_after` / `added_before` | Cache snapshot + RF (when mutable filter also present) | Immutable — snapshot predicate on tier-1, `added_on` date filter appended to RF calls |
| `linkedin_profile` | Cache snapshot (exact slug) + RF substring (when mutable filter present) | Dual-handled; both predicates AND |
| `email` | RF `email` text (substring match) | Mutable |
| `company` / `current_organization` | RF `current_company` text | Mutable; RF key is `current_company` |
| `current_title` | RF `current_title` text | Mutable |
| `owner` / `lead_owner_id` | RF `lead_owner` multi-select-by-ID | Mutable; numeric id resolved via `resolveOwner` |
| `stage` (with `job`) | RF `stage` multi-select-by-name + `job` multi-select-by-ID | Mutable; stage fuzzy-resolved against union of `jobs_v2.canonical_pipeline_json` stage names (5-min in-memory cache) |
| `disqualified: true` | RF `stage='Disqualified'` | No boolean DQ filter in RF |
| `technology` / `segment` / `role` | RF `custom_field.<id>` multi-select | Mutable; canonical option name + numeric id resolved via cached `/candidate/custom-field/list`. Map fetch failure surfaces `warning: 'custom_field_map_unavailable'`. |

### Per-job pipelines, not a global canonical list

**There is NO global canonical stage list.** Each RF job defines its own pipeline (Phone Screen vs no Phone Screen, Take-home vs Onsite, Final Interview optional, etc).

RF's `/job/pipeline?job_id=X` returns a canonical, ordered `summary[]` of stages (with aggregate counts, including 0-count stages). This is fetched live on every pipeline request; range filters and `submitted: true` resolve against this live list, NOT against derived stage names from candidate body fragments.

Landmark stages used by the defaults / submitted ("CV Sent", "Offer", "Hired") do exact-name lookup first, then fuzzy-resolve against the per-job list. When a landmark isn't present in the job's actual pipeline, `submitted: true` falls back to the full canonical list and emits a `_meta.warnings` entry.

### Tool descriptor conventions (`mcp-remote/src/tools.ts`)

The consumer-facing tool descriptors follow the same lean-surface rules as the rest of this doc:

- **`rf_candidate_search`** — `disqualified: true` returns ONLY disqualified candidates (not additive); omitted/false means non-DQ'd only. Mutable, non-load-bearing time filters (`updated_*`) are not exposed. The description documents the recoverable warnings (`filter_unverified` when RF is unreachable, `custom_field_map_unavailable` when the custom-field list can't be fetched) and the `{ok: false, kind: 'rate_limited', retry_after_ms}` shape for RF rate limits.
- **`rf_job_pipeline`** / **`rf_job_candidates_filter`** — both read live RF (no pipeline cache), expose `include_disqualified` (default false), and document `pipeline_unavailable` / `hydration_errors[]` / `truncated` in their descriptions. Neither carries an orphan `filters` object — filters are named top-level fields.
