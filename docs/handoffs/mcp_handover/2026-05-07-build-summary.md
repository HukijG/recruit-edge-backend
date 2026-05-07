# MCP middleware build — final summary

> Snapshot of the project state at hand-off. For the consumer-side API contract see `2026-05-07-consumer-side-reference.md`. For the design rationale see `docs/archive/specs/2026-05-07-mcp-middleware-design.md`. For the original brief see `2026-05-07-mcp-middleware-handover.md`.

**Status: live, deployed, verified.**

## What was built

Two Cloudflare Workers, one shared D1, one shared KV.

### `rf-dialpad-sync-dev` (existing main worker, extended)
- New POST surface under `/mcp/*` — 7 endpoints (candidate-search, candidate-get, candidate-move-stage, candidate-log-interview, job-candidates-filter, job-pipeline, cache-status).
- New entity-reference resolvers (`src/mcp/resolvers.js`) — fuzzy `candidate` / `job` / `stage` / `owner` everywhere. Numeric ids still accepted as fallback.
- Field projection (`src/mcp/projection.js`) — Claude passes `linkedin` / `salary` / `tech stack` / etc; middleware resolves to canonical paths.
- Pure-fuzzy snapshot (`src/mcp/snapshot.js`) — version-checked cache of {id, name, prepared tokens, last_activity_at} for all candidates.
- Auth: `MCP_EXTENSION_SECRET` shared secret in `X-MCP-Token` header.
- Deployed: yes, version `bd2072c7-aaf0-492c-98c8-7ced61db73f0`+ (auto-deploys from master via existing GitHub integration).

### `rf-mcp-cache-sync` (new worker, isolated subtree under `sync-worker/`)
- Cron `*/15 * * * *` runs `tailSync` — fetches RF candidates updated in the last window, upserts to D1, refreshes the per-job KV snapshots.
- `POST /admin/full-rebuild` (gated by `ADMIN_SECRET`) kicks off `FullRebuildWorkflow` — Cloudflare Workflow that paginates `/candidate/list` 100/page, retries per-page on transient RF 502s, refreshes reference tables, then rebuilds all snapshots.
- Sole writer to D1 + `mcp:*` KV keys. Discipline rule (code-review enforced): main worker never writes either.
- Deployed: yes, auto-deploys from master via the GitHub integration on the `/sync-worker` root directory.

### Shared resources
- **D1 database `rf-mcp-cache`** (id `00000000-0000-0000-0000-000000000001`, region WEUR). Tables: `candidates`, `candidate_jobs` (denormalised link table for fast per-job JOINs), `jobs`, `sync_state`. Migrations in `sync-worker/migrations/`.
- **KV namespace `SYNC_STATE`** — pre-existing, now also holds `mcp:pipeline:{jobId}` and `mcp:job-candidates:{jobId}` snapshots (1h TTL, refreshed every cron tick).

## Production state (last verified 2026-05-07)

```
candidates_count: 27,283
jobs_count:        925
last_full_rebuild_at: 2026-05-07T18:49:50Z
last_tail_sync_at:    advancing every 15 min
```

## Critical gotchas discovered along the way

1. **RF response shapes are inconsistent across endpoints.** `/candidate/list` returns a bare JSON array; `/candidate/search` returns a bare array WITHOUT `include_count`, but `{data, total_items}` WITH it; `/user/list` always returns `{data}`. Our clients (`sync-worker/src/rf-list-client.js`) handle both shapes defensively.

2. **RF field names differ from intuition.** `current_designation` (not `current_title`), `latest_activity_time` (not `last_activity_at`), `email[]` array (not `primary_email`), `phone_number[]` array of strings (not `phone_numbers[].phone_number`), `linkedin_profile` is a SLUG (not URL), `source_name` on `/list` vs `source` on `/get`. Every alias lives in `sync-worker/src/normalize.js`.

3. **RF `/candidate/list` caps at 100 per page.** Our `PAGE_SIZE` constant in `sync-worker/src/workflow.js` matches. Any change here will hit a 400.

4. **`/candidate/search` requires non-empty filters.** The right shape for "candidates with activity since cursor" is:
   ```json
   { "filter_type": "after", "is_relative": false, "date": "YYYY-MM-DD",
     "key": "last_activity", "type": "date" }
   ```
   `last_updated` is rejected as a filter key.

5. **RF has no boolean `disqualified` field on candidate's `jobs[]`.** Derived from `stage_name === 'Disqualified'`. See `toCandidateJobRows` in `normalize.js`.

6. **`/activity-type/list` and `/customfield/list` return 404.** They might not exist on RF or might require a different path. Our `fetchActivityTypes` / `fetchCustomFieldSchema` swallow 404 and return `[]` — reference data is best-effort, the rebuild proceeds without them.

## Operational

### Triggering a full rebuild
```bash
curl -X POST https://rf-mcp-cache-sync.example-account.workers.dev/admin/full-rebuild \
  -H "X-Admin-Token: <ADMIN_SECRET>"
```
Returns `202 + { workflow_id }` immediately; Workflow runs ~5–10 min for ~50k candidates.

### Manual D1 cleanup (rare)
```bash
cd sync-worker
npx wrangler d1 execute rf-mcp-cache --remote --config wrangler.sync.jsonc \
  --command "DELETE FROM sync_state WHERE key = 'in_flight'"
```
The `in_flight` token can stick if a Workflow is force-terminated. Watchdog auto-clears after 6h of `last_tail_sync_at` not advancing.

### Smoke test
```bash
MCP=<MCP_EXTENSION_SECRET>
BASE=https://rf-dialpad-sync-dev.example-account.workers.dev

curl -X POST $BASE/mcp/cache-status -H "X-MCP-Token: $MCP" \
  -H "Content-Type: application/json" \
  -d '{"consultantFirstName":"Joel"}'
```

## Test surface

| Suite | Tests | Notes |
|---|---|---|
| Main worker | 504 | All `/mcp/*` endpoints + resolvers + projection + snapshot + existing webhook flows |
| Sync worker | 66 | Normaliser + RF client + D1 writes + snapshot rebuild + tail sync + admin endpoint |

Run from repo root: `npx vitest run`. Run from sync-worker: `cd sync-worker && npx vitest run`.

## What's NOT included (future work)

These are noted in the design spec under "Future work":

1. **R2 + AI Search natural-language discovery.** A `/mcp/candidate-discover` endpoint for open-ended exploration ("candidates with telemetry-company experience"). Sync worker would dual-write D1 + R2; AI Search auto-indexes from R2. ~1 day of work, fully additive.

2. **FTS5 over candidate names in D1.** If pure-fuzzy queries (~50k corpus) get slow, promote name matching to FTS5. Snapshot pattern is sufficient today.

3. **Resolver expansion.** The user explicitly said any input that goes to RF should be fuzzy-resolved. We covered `candidate`, `job`, `stage`, `owner`. Not yet covered: `technology`, `segment`, `role` (custom-field values — exact match today). If a recruiter consistently mistypes "k8s" vs "Kubernetes", expand the resolver — don't add normalisation to the consumer.

## Development notes for future sessions

- **Branch model**: master is the deploy target. Both workers auto-deploy from master via Cloudflare Workers Builds.
- **Per-worker deploy isolation**: build watch paths set in CF dashboard. Main worker excludes `sync-worker/**`; sync worker root-directory is `/sync-worker`.
- **Secrets** live in CF dashboard, not in the repo. `MCP_EXTENSION_SECRET` on main, `ADMIN_SECRET` + `RF_API_KEY` on sync.
- **Don't write D1 from main worker.** Code review enforced. The discipline keeps the schema audit trail clean.
- **Don't add normalisation in the local MCP.** The middleware is the resolver layer. New tools / aliases / fuzzy edges go in `src/mcp/`, not on the consumer side.
