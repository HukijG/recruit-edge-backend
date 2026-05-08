# MCP Middleware

Server side of the local MCP migration. A thin router (`src/mcp/router.js`) under `/mcp/*` resolves `consultantFirstName` → registry user, then dispatches to per-tool middleware handlers in `src/mcp/`. Read-only against a shared D1 cache (`RF_MCP_CACHE`); pipeline data sourced from the `job_pipelines` table (rebuilt every 15 min by the sync worker).

**Reference design:**
- Latest spec: `docs/archive/specs/2026-05-08-mcp-defaults-and-pipeline.md` (defaults union, `*_id` short-circuit, `job_pipelines` D1 table, lean `_meta`, LinkedIn URL output)
- Latest plan: `docs/archive/plans/2026-05-08-mcp-defaults-and-pipeline.md`
- Original spec (partially superseded): `docs/archive/specs/2026-05-07-mcp-middleware-design.md`
- Original plan (partially superseded): `docs/archive/plans/2026-05-07-mcp-middleware.md`

## Mental model

Claude never has ids — it has names. The middleware does ALL alias / fuzzy / acronym resolution server-side. The local MCP is a transparent forwarder that injects auth + `consultantFirstName` and returns the JSON verbatim. **Do NOT add client-side normalisation on the consumer.** If a query is hard to resolve, expand the resolver, not the consumer.

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

## Auth secrets

- `MCP_EXTENSION_SECRET` — shared, in `X-MCP-Token` header for `/mcp/*`
- `ADMIN_SECRET` — sync worker only, in `X-Admin-Token` header for `POST /admin/full-rebuild`

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
| `/mcp/job-pipeline` | `job_id` |
| `/mcp/job-candidates-filter` | `job_id` |

When a `*_id` field is present, the corresponding fuzzy-name field (`candidate`, `job`, etc.) is ignored — no double-pass, no merge.

### Fuzzy job scope

`resolveJob` defaults to **open jobs only** (`is_open=1`). Closed jobs are excluded from fuzzy scoring entirely; recruiters reach a closed job only by passing an explicit numeric id. The `restrictTo` path (move-stage / log-interview against a candidate's own jobs[]) ignores `onlyOpen` since the universe is already constrained.

### Recency boost

`recencyBoost` in `fuzzy.js` decays linearly over a **30-day window** (down from the original 180). Within UNIQUE_GAP, a candidate active today wins outright over the same-name twin from two months ago. Recruiters typing first names almost always mean someone they've spoken to in the last week or two; the tighter window matches that expectation.

### Post-narrow disambiguation on writes

`candidate-move-stage` and `candidate-log-interview` enumerate every valid `(candidate, job, stage)` tuple and only ambiguate when ≥2 valid tuples remain.

- When candidate is fuzzy-ambiguous but only one match has the requested job/stage → worker auto-commits, no round-trip.
- When ≥2 tuples remain → `kind` is the smallest level of variation (candidates differ → `candidate`, same candidate but jobs differ → `job`, etc.) and options carry just enough tuple context to disambiguate at that level.

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

All under `/mcp/*`, authed via `X-MCP-Token` header.

| Endpoint | Purpose |
|---|---|
| `/mcp/cache-status` | Returns sync_state stamps + table counts; cheap health probe. |
| `/mcp/candidate-search` | Filter (D1 SELECT with WHERE on indexed cols + JSON1 fanout for `technology`/`segment`/`role` + `candidate_jobs` JOIN for `job`/`stage`; `include_disqualified` flips the JOIN guard) and/or fuzzy (in-memory snapshot, top-K). `query` + filters → SQL narrow then fuzzy rank. `job` + `owner` accept names via the resolver. |
| `/mcp/candidate-get` | By id (D1 SELECT) or by `query` (fuzzy via snapshot, `needs_disambiguation` if top-2 within 0.08). |
| `/mcp/candidate-move-stage` | Fuzzy-resolves candidate/job/stage, calls RF `/candidate/move-to-stage` attributed to consultant. |
| `/mcp/candidate-log-interview` | Fuzzy-resolves candidate (+ optional job restricted to candidate's jobs); creates RF custom activity (interview activity-type id resolved dynamically from `sync_state.activity_types`); returns `outlook_url` (recruiter-only block — no candidate email on `to=`) and optional `gcal_hint` based on `consultant.calendarMode`. |
| `/mcp/job-candidates-filter` | Fuzzy-resolves `job` (or `job_id` short-circuit). Reads active candidates from `job_pipelines.stage_candidates_json`; hydrates from `candidates`. `stage` filter (fuzzy against `summary_json`); `limit` (default 100, max 500); `truncated` flag when more matched than fit. |
| `/mcp/job-pipeline` | Fuzzy-resolves `job` (or `job_id` short-circuit). Reads canonical pipeline from `job_pipelines.summary_json`; hydrates active candidates from `candidates`. Filters: `stage` (single, fuzzy), `from`/`to` (range, fuzzy against `summary[]`), `submitted: true` (exact match on 'CV Sent' → end of pipeline). Default: same as `submitted`. Disqualified excluded unless `include_disqualified: true`. Cold-cache returns 200 + warning. |

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
7. **Tests.** Add `test/mcp-<name>.spec.js` modeled on the existing specs (e.g. `test/mcp-job-pipeline.spec.js`). Use `import { env, createExecutionContext } from 'cloudflare:test';` and `applyMigration(env)` in `beforeEach`. Set `'X-MCP-Token': 'test-mcp-extension-secret'` and include `consultantFirstName: 'Joel'` in the body for auth.
8. **Consumer doc.** If the new endpoint is meant for the local MCP, update `docs/handoffs/mcp_handover/2026-05-07-consumer-side-reference.md` with the body params, response shape, and the default field set so the LLM agent's tool descriptions can sync.
9. **Endpoint table.** Add a row to the table above. If the endpoint adds a new `*_id` body field, add it to the ID short-circuit table too.

If the new endpoint requires data NOT already in D1, that's a sync-worker change — extend the rebuild workflow, not the read path. Read paths must never call RF directly except for the four write endpoints (`move-stage`, `log-interview`, etc.) where it's intentional.

### Per-job pipelines, not a global canonical list

**There is NO global canonical stage list.** Each RF job defines its own pipeline (Phone Screen vs no Phone Screen, Take-home vs Onsite, Final Interview optional, etc).

RF's `/job/pipeline?job_id=X` returns a canonical, ordered `summary[]` of stages (with aggregate counts, including 0-count stages). The sync-worker writes that array verbatim to `job_pipelines.summary_json` per open job, every 15 min via `PipelineRebuildWorkflow`. The main worker reads it; range filters and `submitted: true` resolve against this canonical list, NOT against derived stage names from candidate body fragments.

Landmark stages used by the defaults / submitted ("CV Sent", "Offer", "Hired") do exact-name lookup first, then fuzzy-resolve against the per-job list. When a landmark isn't present in the job's actual pipeline, `submitted: true` falls back to the full canonical list and emits a `_meta.warnings` entry.
