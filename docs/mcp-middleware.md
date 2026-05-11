# MCP Middleware

Server side of the MCP layer. A thin router (`src/mcp/router.js`) under `/mcp/*` resolves the consultant from a verified Access JWT (`consultantEmail` body field, forwarded over the service binding from `rf-mcp-remote` — see `docs/security.md`), then dispatches to per-tool middleware handlers in `src/mcp/`. Read-only against a shared D1 cache (`RF_MCP_CACHE`); pipeline data sourced from the `job_pipelines` table (rebuilt every 15 min by the sync worker — though the cron is currently OFF; see `docs/architecture.md` § Sync worker).

The `rf-mcp-remote` MCP worker (`mcp-worker/`) is the public Streamable-HTTP front; it validates the Access JWT, then service-binds into this `/mcp/*` surface. Architecture overview in `docs/architecture.md`. Auth shape in `docs/security.md`.

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

### Lean tool definitions — `mcp-worker/src/tools.ts`

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
| **Sync worker** (`sync-worker/`, isolated subtree, own `wrangler.jsonc`, deployed independently via GitHub build watch path) | Sole writer. Runs the cron tail-sync (every 15 min) and the admin-triggered full rebuild Workflow. Also runs `PipelineRebuildWorkflow` every 15 min. **Sole writer to D1.** |

> **Discipline rule: no main-worker code path may write D1.** That invariant keeps the sync surface auditable and prevents schema drift between writers.

## Storage

**D1 binding** `RF_MCP_CACHE` is shared between both workers (sync writes, main reads). Schema across migrations in `sync-worker/migrations/`:
- `candidates`, `candidate_jobs`, `jobs`, `sync_state` — `0001_init.sql`
- `job_pipelines` — `0002_job_pipelines.sql`

Tail sync re-fetches `/job/list` every tick so new jobs and open-status flips surface within 15 min without waiting for a manual rebuild. Full rebuild bumps both `last_full_rebuild_at` and `last_tail_sync_at` so the main worker's snapshot version pin reloads.

Pipeline data lives in the `job_pipelines` D1 table, populated by `PipelineRebuildWorkflow` every 15 min from RF `/job/pipeline`. The old `mcp:pipeline:{jobId}` and `mcp:job-candidates:{jobId}` KV keys are gone.

## Auth

- `/mcp/*` (main worker) accepts only service-binding traffic from `rf-mcp-remote`. Identity arrives as the `consultantEmail` body field; no shared-secret header. `MCP_EXTENSION_SECRET` was retired 2026-05-10. See `docs/security.md` for the JWT validation flow.
- A transitional `consultantFirstName` body fallback survives in `src/mcp/router.js` for legacy local-MCP installs; it logs `[mcp] legacy consultantFirstName fallback` and is dropped when Spec B Phase 3 lands.
- `ADMIN_SECRET` — sync worker only, in `X-Admin-Token` header for `POST /admin/full-rebuild`. Internal admin path; not user-facing.

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

### Recency boost

`recencyBoost` in `fuzzy.js` decays linearly over a **30-day window** (down from the original 180). Within UNIQUE_GAP, a candidate active today wins outright over the same-name twin from two months ago. Recruiters typing first names almost always mean someone they've spoken to in the last week or two; the tighter window matches that expectation.

### Post-narrow disambiguation on writes

`candidate-move-stage`, `candidate-log-interview`, and `candidate-add-note` enumerate every valid candidate (and `(candidate, job, stage)` tuple where relevant) and only ambiguate when ≥2 valid options remain.

- When candidate is fuzzy-ambiguous but only one match has the requested job/stage → worker auto-commits, no round-trip.
- When ≥2 tuples remain → `kind` is the smallest level of variation (candidates differ → `candidate`, same candidate but jobs differ → `job`, etc.) and options carry just enough tuple context to disambiguate at that level.

`candidate-call-notes` step=list_calls uses the same standard `needs_disambiguation` envelope when the fuzzy candidate name resolves to multiple options; its step=submit_notes fallback path delegates to `candidate-add-note` so the disambiguation semantics are identical.

### Stage resolution coverage

`stage` is fuzzy on every endpoint that accepts it:
- `candidate-move-stage` (against the target job's `stages[]`)
- `candidate-search` (against `candidate_jobs.stage_name` for the resolved job)
- `job-pipeline` and `job-candidates-filter` (against `summary_json`'s stage names for the resolved job)

Ambiguity returns the standard envelope; not_found on the read-side endpoints falls through to literal exact-match (so unknowns still return empty results, never 404).

### Custom-field filter resolution

`technology` (multi-select), `segment`, and `role` filters on `candidate-search` are also fuzzy-resolved against the live universe of distinct values from candidate bodies. Worker globals memoise the universe with `last_tail_sync_at` version-checking.

- Case-insensitivity ("kubernetes" → "Kubernetes") and prefix matching ("ent" → "Enterprise") work out of the box
- **Synonym mapping (e.g. "k8s" → "Kubernetes") is NOT covered** — for that, add the alias to a future explicit alias dictionary, don't push normalisation onto the consumer

## Endpoints

All under `/mcp/*`. Identity is the verified `consultantEmail` body field (forwarded by `rf-mcp-remote` from the Access JWT). No header auth — service-binding traffic is trust-local within the Cloudflare account boundary.

| Endpoint | Purpose |
|---|---|
| `/mcp/cache-status` | Returns sync_state stamps + table counts; cheap health probe. |
| `/mcp/candidate-search` | Filter (D1 SELECT with WHERE on indexed cols + JSON1 fanout for `technology`/`segment`/`role` + `candidate_jobs` JOIN for `job`/`stage`; `include_disqualified` flips the JOIN guard) and/or fuzzy (in-memory snapshot, top-K). `query` + filters → SQL narrow then fuzzy rank. `job` + `owner` accept names via the resolver. |
| `/mcp/candidate-get` | By id (D1 SELECT) or by `query` (fuzzy via snapshot, `needs_disambiguation` if top-2 within 0.08). |
| `/mcp/candidate-move-stage` | Fuzzy-resolves candidate/job/stage, calls RF `/candidate/move-to-stage` attributed to consultant. |
| `/mcp/candidate-log-interview` | Fuzzy-resolves candidate (+ optional job restricted to candidate's jobs); creates RF custom activity (interview activity-type id resolved dynamically from `sync_state.activity_types`); returns `outlook_url` (recruiter-only block — no candidate email on `to=`) and optional `gcal_hint` based on `consultant.calendarMode`. |
| `/mcp/candidate-add-note` | Fuzzy-resolves candidate (+ optional job restricted to candidate's jobs); renders markdown body → HTML via `marked` (in `src/mcp/markdown.js`); calls RF `/candidate/notes/add` attributed to `consultant.rfUserId` from the JWT. No `mentions` resolution, no attribution override. Success returns `{ok: true}` only — no echo back (per the lean-response convention). Exposes an internal `addNoteForCandidate(...)` for in-process reuse. |
| `/mcp/candidate-call-notes` | Three-stage Dialpad-call → structured RF note. `step='list_calls'` fuzzy-resolves candidate + paginates `GET /api/v2/call` (target_id=consultant.dialpadId, target_type='user'), filters to ≥2 min `total_duration` matching the candidate's RF id (via `extractRFIdFromDialpadContact` on `call.contact.id`). `step='get_transcript'` checks `call.target.id == consultant.dialpadId`, derives candidate, fetches `/transcripts/{call_id}`, filters to `type='transcript'` lines, returns transcript + the call-notes rendering brief. `step='submit_notes'` delegates to `addNoteForCandidate` (fast path) or `handleCandidateAddNote` (fuzzy fallback). |
| `/mcp/job-candidates-filter` | Fuzzy-resolves `job` (or `job_id` short-circuit). Reads active candidates from `job_pipelines.stage_candidates_json`; hydrates from `candidates`. `stage` filter (fuzzy against `summary_json`); `limit` (default 100, max 500); `truncated` flag when more matched than fit. |
| `/mcp/job-pipeline` | Fuzzy-resolves `job` (or `job_id` short-circuit). Reads canonical pipeline from `job_pipelines.summary_json`; hydrates active candidates from `candidates`. Filters: `stage` (single, fuzzy), `from`/`to` (range, fuzzy against `summary[]`), `submitted: true` (exact match on 'CV Sent' → end of pipeline). Default: same as `submitted`. Disqualified excluded unless `include_disqualified: true`. Cold-cache returns 200 + warning. |

### Three-step Dialpad-call-to-note flow

`/mcp/candidate-call-notes` is the only multi-stage endpoint on the MCP surface. It exists because Claude has to round-trip with the user between stages (which call → user picks one → notes drafted → user accepts → commit), so the natural shape is three separate API calls keyed by a `step` discriminator.

Stages and their data flow:
1. `list_calls`: candidate ref + time window → list of `{call_id, started_at, duration_minutes, direction}`. Candidate ambiguity returns the standard `needs_disambiguation` envelope; no Dialpad call is made.
2. `get_transcript`: `call_id` → `{candidate, call, transcript, guidance}`. Per-record auth: `call.target.id == consultant.dialpadId` (rejected as `kind: 'not_your_call'` otherwise — Access JWT plus this per-record check is the layered authorization).
3. `submit_notes`: `candidate_id` (fast) OR `candidate_fallback` (fuzzy) plus markdown `note` → `{ok: true}`. The fuzzy path delegates to `handleCandidateAddNote` verbatim.

Full design: the candidate-call-notes design (2026-05-10).

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
6. **D1 reads.** Use `session(env)` from `./d1-read.js` to get a session-pinned reader (sync-worker writes are read-after-write consistent within the session). NEVER write to D1 from the main worker — that's the sync worker's exclusive responsibility.
7. **Tests.** Add `test/mcp-<name>.spec.js` modeled on the existing specs (e.g. `test/mcp-job-pipeline.spec.js`). Use `import { env, createExecutionContext } from 'cloudflare:test';` and `applyMigration(env)` in `beforeEach`. Identity arrives in the body — pass either `consultantEmail: 'joel@<test-domain>'` (current path) or `consultantFirstName: 'Joel'` (legacy fallback path, exercised by existing specs while it remains wired). The `X-MCP-Token` header is no longer validated; specs that still set it work fine but the header is a no-op.
8. **Consumer surface.** Tool registrations + descriptions live in `mcp-worker/src/tools.ts` (`registerTools`). Add a `server.registerTool(...)` block there with the body params, response shape, and the default field set so the LLM client's tool list reflects the new endpoint. If the new tool is the read endpoint Claude should always have loaded, set `_meta: { "anthropic/alwaysLoad": true }`.
9. **Endpoint table.** Add a row to the table above. If the endpoint adds a new `*_id` body field, add it to the ID short-circuit table too.

If the new endpoint requires data NOT already in D1, that's a sync-worker change — extend the rebuild workflow, not the read path. Read paths must never call RF directly except for the four write endpoints (`move-stage`, `log-interview`, etc.) where it's intentional.

### Per-job pipelines, not a global canonical list

**There is NO global canonical stage list.** Each RF job defines its own pipeline (Phone Screen vs no Phone Screen, Take-home vs Onsite, Final Interview optional, etc).

RF's `/job/pipeline?job_id=X` returns a canonical, ordered `summary[]` of stages (with aggregate counts, including 0-count stages). The sync-worker writes that array verbatim to `job_pipelines.summary_json` per open job, every 15 min via `PipelineRebuildWorkflow`. The main worker reads it; range filters and `submitted: true` resolve against this canonical list, NOT against derived stage names from candidate body fragments.

Landmark stages used by the defaults / submitted ("CV Sent", "Offer", "Hired") do exact-name lookup first, then fuzzy-resolve against the per-job list. When a landmark isn't present in the job's actual pipeline, `submitted: true` falls back to the full canonical list and emits a `_meta.warnings` entry.
