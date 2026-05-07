# Handover: MCP routing surface + D1 cache + sync worker

> Audience: the Claude agent working in the `recruiterflow-mcp-middleware` repo (the Cloudflare worker at `rf-dialpad-sync-dev`).
>
> Purpose: build the server side of an MCP migration. The local MCP (a separate Node project running on the consultant's machine inside Claude Desktop via stdio) is being slimmed down to a thin router. All cache, fuzzy resolution, and RF API access moves into your worker. This doc tells you exactly what to build.
>
> You will NOT see the MCP code. You don't need to. The MCP will be updated to call your endpoints — what matters here is that you build the contract this doc specifies.

## What you're building

Three things, additive to your existing `rf-dialpad-sync-dev` worker:

1. **A new D1 database** holding the full RF candidate corpus (and a small jobs table). Source of truth for cached reads.
2. **A new `/mcp/*` endpoint surface on the existing worker.** Reads serve from D1, writes proxy to RF directly.
3. **A new sync worker** in the same repo (separate `wrangler.<name>.jsonc` + entry) that runs every 15 min, pulls recently-updated candidates from RF, and upserts into D1.

You will also add a new shared secret (`MCP_EXTENSION_SECRET`) and a new admin secret (`ADMIN_SECRET` for the sync worker's full-rebuild endpoint).

## Existing context you can reuse

Your repo's `architecture.md` has the full picture of what's already there. Two things in particular are directly reusable:

- **`src/users.js`** — the `{ firstName, rfUserId, dialpadId }` registry. You'll use `getUserByFirstName` to resolve `consultantFirstName` → `rfUserId` for write attribution. Lift this verbatim.
- **`src/rf-client.js`** — the RF API client (search/get/update, normalisation helpers). Lift the candidate-shape normalisation into the sync worker.

The KV-backed `candidate:{rfId}` cache is OUT OF SCOPE for this work. It serves the LinkedIn extension and other paths; leave it alone. D1 is a brand-new substrate that lives alongside the existing KV cache, not a replacement.

## Auth contract

### `MCP_EXTENSION_SECRET` (shared secret, MCP ↔ main worker)

- New Cloudflare-managed secret on `rf-dialpad-sync-dev`.
- Sent on every `/mcp/*` request as **`X-MCP-Token: <value>`**.
- Constant-time compare against `env.MCP_EXTENSION_SECRET`. Fail closed: missing/wrong → `401 { ok: false, error: "..." }`.
- Distinct from `LINKEDIN_EXTENSION_SECRET`. Do not collapse them.

### `consultantFirstName` body field

- Every `/mcp/*` POST has `consultantFirstName: string` in the body.
- Resolve via `getUserByFirstName(name)`. If unknown → `403 { ok: false, error: "Unknown consultant" }`.
- For writes: the resolved `rfUserId` becomes the `user_id` parameter on the RF write call.
- For reads: log the consultant for traceability; the query itself is identity-agnostic.

### `ADMIN_SECRET` (sync worker only)

- New Cloudflare-managed secret on the sync worker.
- Sent as **`X-Admin-Token: <value>`** on the full-rebuild endpoint only.
- Used by the human (Joel) to manually trigger a full rebuild from his terminal. Never reachable from the MCP.

## D1 schema

Provision a new D1 database. Suggested binding name on both workers: `RF_MCP_CACHE`.

```sql
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,                -- JSON.stringify(RF /candidate/get response, full payload)
  -- extracted columns (indexed)
  name TEXT,
  primary_email TEXT,
  linkedin_profile TEXT,             -- normalised slug, e.g. "john-smith"
  current_organization TEXT,
  current_title TEXT,
  lead_owner_id INTEGER,
  added_time TEXT,                   -- ISO 8601
  last_updated TEXT,                 -- ISO 8601 — drives sync ordering
  last_activity_at TEXT,             -- ISO 8601 (nullable)
  cached_at TEXT NOT NULL            -- when this row was last upserted by sync
);
CREATE INDEX idx_candidates_email        ON candidates(primary_email);
CREATE INDEX idx_candidates_linkedin     ON candidates(linkedin_profile);
CREATE INDEX idx_candidates_lead_owner   ON candidates(lead_owner_id);
CREATE INDEX idx_candidates_last_updated ON candidates(last_updated);
CREATE INDEX idx_candidates_added_time   ON candidates(added_time);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,                -- JSON.stringify(RF /job/get or /job/list row)
  name TEXT,
  client_company_name TEXT,
  is_open INTEGER,                   -- 0/1
  cached_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_open ON jobs(is_open);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                -- JSON-encoded
);
-- Conventional keys:
--   'last_tail_sync_at'        ISO 8601 string
--   'last_tail_sync_count'     number
--   'last_tail_sync_pages'     number
--   'last_full_rebuild_at'     ISO 8601 string
--   'activity_types'           JSON array — small registry, refresh on full rebuild
--   'users'                    JSON array — RF user list, refresh on full rebuild
--   'custom_field_schema'      JSON array — refresh on full rebuild
--   'in_flight'                "true" / absent
```

### Why JSON column + extracted indexed columns?

RF's candidate shape is fluid (custom fields, education, experience, file links, notes). Normalising means schema-migrating every time RF adds a field. SQLite's JSON1 (`json_extract`, `json_each`) handles the long tail well enough on 50k rows once `last_updated` is indexed. Extract only the columns we always filter by; everything else stays in `body`.

### Schema migrations

Use `wrangler d1 migrations create` and ship the schema as numbered migrations from day one. The user (Joel) will be applying changes via the existing GitHub-push-to-deploy pipeline; making this clean from the start avoids ad-hoc SQL execution later.

### Bulk write batching

D1 transactions cap at 100 statements. The sync worker must batch upserts in chunks of ≤100. Use prepared statements + `db.batch([stmt1, stmt2, ...])`.

## `/mcp/*` endpoints (main worker)

All POST. All require `X-MCP-Token: <MCP_EXTENSION_SECRET>` (`401` if missing/wrong). All bodies have `consultantFirstName: string` (`400` if missing, `403` if unknown). All return `application/json`.

> **Discipline:** the main worker MUST NOT write to D1. Only the sync worker writes. This is code-review-enforced, not Cloudflare-permission-enforced. Don't add D1 writes to any `/mcp/*` handler — even after a successful RF write. The next sync cycle will reconcile within 15 min.

### `POST /mcp/candidate-search`

Read. Fuzzy-resolve a candidate (or apply a structured filter) and return matches.

```
Body:
  consultantFirstName: string         // logged only on reads
  query?: string                      // fuzzy name/email
  job?: string | number               // resolved to job_id server-side
  stage?: string                      // candidate must be at this stage on `job` (or any open job if `job` omitted)
  owner?: string                      // candidate's lead_owner — name / email / id
  company?: string                    // current_organization — substring match for now
  email?: string                      // exact match (lowercase compare)
  technology?: string[]               // custom field "Technology" multi-select — match if ANY value present
  segment?: string                    // custom field "Segment" — exact match
  role?: string                       // custom field "Role" — exact match
  added_after?: string                // ISO date
  added_before?: string
  updated_after?: string
  updated_before?: string
  include_disqualified?: boolean      // default false
  limit?: number                      // default 5, max 50
  fields?: string[]                   // projection — see "Field projection" below

Response:
  200 OK
  { count, matches: [{ id, name, ...projected }] }
  | { needs_disambiguation: "job" | "owner", options: [...] }
  | { count: 0, matches: [], hint?: string }
```

Implementation notes:

- Fuzzy name resolution: token + Levenshtein scorer with recency boost — see "Fuzzy resolution" section below. Lift the algorithm from the existing MCP's `src/fuzzy.ts` (Joel will provide that file separately if needed).
- Filters apply BEFORE fuzzy scoring narrows the pool.
- `technology` — uses `json_each(body, '$.custom_fields')` to find the entry where `name = 'Technology'`, then `json_each(value, '$.value')` over its array. Match if ANY query value appears.
- `segment` / `role` — single-string custom fields; `json_extract` exact match.
- `query` is optional. With no query and just filters, return rows by `last_updated DESC` (most recent first).

### `POST /mcp/candidate-get`

Read. One full record with optional projection.

```
Body:
  consultantFirstName: string
  id?: number                         // exactly one of id/query
  query?: string
  fields?: string[]                   // see "Field projection"

Response:
  200 OK
  { candidate: { id, name, ...projected } }
  | { needs_disambiguation: true, options: [...] }
  | 404 { error: "No match" }
```

Implementation: load `body` from D1, parse, apply projection, return.

### `POST /mcp/candidate-move-stage`

Write. RF round-trip; no D1 write.

```
Body:
  consultantFirstName: string         // → rfUserId for RF user_id parameter
  candidate: string | number          // resolve via candidate-search if string
  job?: string | number               // optional; if omitted, use candidate's single non-DQ job
  stage: string | number              // resolved against job pipeline
  force?: boolean                     // override disambiguation if multiple candidate matches

Response:
  200 OK
  { ok: true, moved: { candidate_id, candidate_name, job_id, job_name, from_stage, to_stage } }
  | { needs_disambiguation: true, kind: "candidate" | "job" | "stage", options: [...] }
  | { error: string }
```

Implementation:

1. Resolve all three references (candidate, job, stage). If any ambiguous → return disambiguation; do not guess.
2. Read candidate body from D1 to confirm current stage on the chosen job.
3. POST `/api/external/candidate/move-to-stage` to RF with `user_id = rfUserId`.
4. Return success. Do NOT write to D1; the sync worker will pick up the new state within 15 min.

### `POST /mcp/candidate-log-interview`

Write. Creates an Interview activity on the RF timeline.

```
Body:
  consultantFirstName: string
  candidate: string | number
  job?: string | number
  kind: string                        // verbatim: "1st Interview" | "2nd Interview" | ... | "Final Interview"
  start_time: string                  // ISO 8601 with timezone offset (REQUIRED)
  end_time?: string                   // default = start + 60 min
  context?: string                    // freeform; one bullet per newline

Response:
  200 OK
  {
    ok: true,
    activity: { id, candidate_id, kind },
    gcal_hint?: { summary, description, start, end, calendarId, attendees: [] },
    outlook_url?: string,
    next_step: string
  }
```

Implementation:

- Resolve candidate + (optional) job.
- POST to RF `/custom-activity/create` (or whatever endpoint the existing MCP uses — Joel will surface the exact spec separately if you don't already know).
- The `gcal_hint` vs `outlook_url` decision is per-consultant. For now, surface `outlook_url` always (it's the universal fallback) and gate `gcal_hint` behind a per-consultant flag stored in `users.js` (extend `users.js` with `calendarMode: 'gcal' | 'outlook' | 'both'`, default `'outlook'`).
- `attendees` is **always empty**. Do NOT add the candidate. Recruiter-only calendar block.

### `POST /mcp/job-candidates-filter`

Read. Candidate list for a job.

```
Body:
  consultantFirstName: string
  job: string | number
  stage?: string                      // single stage name
  fields?: string[]
  limit?: number                      // default 100, hard cap 500

Response:
  200 OK
  {
    job: { id, name },
    total_scanned: number,
    matched: [{ id, name, ...projected }],
    truncated?: boolean
  }
```

Implementation: SELECT from candidates WHERE `EXISTS (SELECT 1 FROM json_each(body, '$.jobs') WHERE json_extract(value, '$.job_id') = ? AND (NOT ? OR json_extract(value, '$.stage_name') = ?) AND json_extract(value, '$.disqualified') = 0)`, ordered by name ASC.

### `POST /mcp/job-pipeline`

Read. Pipeline grouped by stage.

```
Body:
  consultantFirstName: string
  job: string | number
  stage?: string                      // narrow to one stage
  submitted?: boolean                 // shortcut: CV Sent onwards
  include_closed?: boolean            // default false (only open jobs match by name)

Response:
  200 OK
  {
    job: { id, name, client_company_name },
    stages: [
      { stage_name: string, count: number, candidates: [{ id, name, stage_moved? }] }
    ]
  }
```

Implementation: same `json_each` join as `job-candidates-filter`, grouped by stage_name. Disqualified candidates excluded. "Submitted" = stage in `[CV Sent, 1st Interview, ..., Hired]` per the project's stage taxonomy.

### `POST /mcp/cache-status`

Read. Read-only diagnostic. No external API calls.

```
Body:
  consultantFirstName: string

Response:
  200 OK
  {
    candidates_count: number,
    jobs_count: number,
    last_tail_sync_at: string | null,
    last_tail_sync_count: number | null,
    minutes_since_last_sync: number | null,
    last_full_rebuild_at: string | null,
    in_flight: boolean
  }
```

Implementation: SELECT COUNT(*) on candidates + jobs; read sync_state values.

## Sync worker (`rf-mcp-cache-sync`)

New worker, same repo. Separate `wrangler.sync.jsonc`, separate entry point (e.g. `src/sync-worker.ts`). Imports `users.js` and `rf-client.js` from the main worker's source tree.

### Cron loop

`crons: ["*/15 * * * *"]` in `wrangler.sync.jsonc`. The cron handler:

```
async function tailSync(env) {
  // Guard: if already in flight, bail (cron should never run concurrently
  // anyway, but be defensive against manual triggers).
  const inFlight = await readSyncState(env, 'in_flight');
  if (inFlight) {
    console.log('[sync] previous run still in flight, skipping');
    return;
  }
  await writeSyncState(env, 'in_flight', 'true');

  try {
    const cursor = (await readSyncState(env, 'last_tail_sync_at'))
      ?? new Date(Date.now() - 60 * 60_000).toISOString();   // default: 1h ago

    let page = 1;
    let totalUpserted = 0;
    let maxLastUpdated = cursor;
    const HARD_CAP = 5000;
    const PAGE_SIZE = 100;

    for (;;) {
      const resp = await rfPost('/api/external/candidate/search', {
        conjunction: 'and',
        filters: [
          // *** TBD: confirm the exact key RF accepts for last_updated date filter ***
          // Likely candidates: 'last_updated', 'updated_after', 'last_updated_at'
          // If none work natively, drop this filter and instead break the loop
          // when row.last_updated < cursor.
          { key: 'last_updated', conjunction: 'gte', values: [cursor] }
        ],
        items_per_page: String(PAGE_SIZE),
        current_page: String(page),
        // *** TBD: confirm sort syntax — RF docs may require a specific shape ***
        sort: [{ key: 'last_updated', direction: 'desc' }]
      });

      const rows = Array.isArray(resp?.data) ? resp.data : [];
      if (rows.length === 0) break;

      // Filter: keep rows newer than cursor (defensive in case the filter is
      // ignored or the API returns boundary rows).
      const fresh = rows.filter(r => r.last_updated > cursor);
      if (fresh.length === 0) break;

      // Upsert in chunks of <= 100 statements per batch.
      for (const chunk of chunks(fresh, 100)) {
        await env.RF_MCP_CACHE.batch(
          chunk.map(row => upsertCandidateStmt(env, row))
        );
      }

      totalUpserted += fresh.length;
      maxLastUpdated = fresh.reduce(
        (m, r) => r.last_updated > m ? r.last_updated : m,
        maxLastUpdated
      );

      if (totalUpserted >= HARD_CAP) {
        console.warn(`[sync] hit hard cap ${HARD_CAP} — possible backlog`);
        break;
      }

      if (rows.length < PAGE_SIZE) break;
      page++;
    }

    await writeSyncState(env, 'last_tail_sync_at', maxLastUpdated);
    await writeSyncState(env, 'last_tail_sync_count', String(totalUpserted));
    await writeSyncState(env, 'last_tail_sync_pages', String(page));
    console.log(`[sync] tail done — ${totalUpserted} upserted across ${page} pages`);
  } finally {
    await deleteSyncState(env, 'in_flight');
  }
}
```

### `POST /admin/full-rebuild` (sync worker)

Manually-triggered. Gated by `X-Admin-Token: <ADMIN_SECRET>`. Runs in `ctx.waitUntil` and returns 202 immediately.

```
1. Walk /candidate/list with items_per_page=500, paginate to total_items.
2. Bulk-upsert into candidates table in chunks of 100.
3. Also refresh: jobs (from /job/list), activity_types (/activity-type/list),
   users (/user/list), custom_field_schema (/customfield/list).
4. On success: sync_state['last_full_rebuild_at'] = now.
5. Log progress to CF Observability every 10 pages.
```

### Failure handling

- **RF 502 mid-pagination**: retry once on the same page; if that also fails, bail and let the next cycle continue from the saved cursor.
- **D1 batch failure**: log + bail. Cursor stays at last successful `maxLastUpdated`; next cycle picks up from there.
- **`last_updated` filter unsupported by RF**: fall back to date-sorted pagination (no filter). Stop walking when `row.last_updated < cursor`.
- **Cron skipped (worker outage)**: next cycle reads the older cursor and catches up. As long as the outage is < ~1 hour, no data is lost (5k headroom).

## Field projection

Lift the alias dictionary + dot-path projection from the existing MCP's `src/projection.ts`. Joel will surface that file separately. Aliases include:

- `email` → `primary_email` + `emails`
- `phone` → `phone_numbers`
- `stage` → `jobs.*.stage_name`
- `title` / `role` → `current_title`
- `company` → `current_organization`
- `linkedin` / `github` / `twitter` → `*_profile`
- `tags` / `skills` (verbatim)
- `added` → `added_time`
- `last_activity` → `last_activity_at`
- `owner` / `recruiter` → `lead_owner`
- `cf.<name>` / `custom.<name>` / bare names → `custom_fields_by_name.<normalised>`

Lean default when `fields` omitted: `{ id, name }` for list responses, `{ id, first_name, last_name, primary_email, phone_numbers, jobs: [{ client_company_name, job_name, stage_name }] }` for `candidate-get`.

## Fuzzy resolution

Lift the scorer from `src/fuzzy.ts`:

1. Normalise: lowercase, strip diacritics, collapse whitespace.
2. Tokenise on whitespace.
3. Score:
   - Exact name match → 1.0
   - All query tokens prefix some name token → 0.9 - 0.05 × token_distance
   - Any query token substring of full name → 0.5 + 0.2 × coverage
   - Levenshtein(query, name) / max_len low → 0.3 + 0.4 × (1 - ratio)
4. Recency boost: `score *= 1 + max(0, 0.2 × (1 - days_since_activity / 180))`.
5. Threshold: 0.35. Below → `none`. Top vs second within 0.08 → `ambiguous`.

For 50k candidates this is in-memory work — load all candidate `name + last_activity_at` into memory once per worker instance and score against that. Cache the array in worker globals (it survives across requests within the same isolate). Refresh the in-memory snapshot if the underlying D1 data changes (rough heuristic: refresh every N minutes or on the first request after a sync_state update).

## Wrangler config notes

- Add D1 binding to BOTH `wrangler.jsonc` (main) and `wrangler.sync.jsonc` (sync). Same `database_id`, same binding name `RF_MCP_CACHE`.
- Add cron trigger to `wrangler.sync.jsonc` only.
- Secrets: `MCP_EXTENSION_SECRET` on main, `ADMIN_SECRET` on sync.
- Both workers share `RF_API_KEY` (already set on main; mirror to sync).

## What's NOT in this work

- Any cold-call surface. The MCP's `rf_cold_call_list` tool is being deprecated. Do not build any cold-call-specific endpoint.
- Activity-count caching. Activity timelines stay live-RF if anything wants them later.
- New search tools beyond what's listed under `candidate-search`. Future tool design happens after this lands.
- Per-user signed JWT auth. We're using the shared-secret pattern this round.
- Webhook-driven D1 updates. Sync worker is the freshness mechanism.

## Verification before declaring done

1. `wrangler d1 execute RF_MCP_CACHE --command "SELECT COUNT(*) FROM candidates"` returns the expected total after a full rebuild.
2. `curl -X POST .../mcp/cache-status -H "X-MCP-Token: ..." -d '{"consultantFirstName":"Joel"}'` returns sensible counts and a recent `last_tail_sync_at`.
3. `curl -X POST .../mcp/candidate-search -H "X-MCP-Token: ..." -d '{"consultantFirstName":"Joel","query":"jerry"}'` returns matches.
4. `curl -X POST .../mcp/candidate-search -H "X-MCP-Token: ..." -d '{"consultantFirstName":"Joel","technology":["Kubernetes"]}'` returns rows whose Technology custom field includes Kubernetes.
5. After 15 min cron tick, `last_tail_sync_at` advances (verify via cache-status).
6. Edit a candidate in RF; within 15 min, the change appears in `/mcp/candidate-get`.
7. Wrong `X-MCP-Token` returns 401. Wrong `consultantFirstName` returns 403.
8. Admin full-rebuild endpoint requires the right `X-Admin-Token`; wrong token returns 401.
