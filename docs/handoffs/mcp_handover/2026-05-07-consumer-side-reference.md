# MCP middleware — consumer-side reference

> Audience: the engineer building the **local MCP** (the thin router running in Claude Desktop via stdio). Everything you need to call the deployed `/mcp/*` surface is in this single doc.

**Base URL:** `https://rf-dialpad-sync-dev.example-account.workers.dev`
**Auth header (every request):** `X-MCP-Token: <MCP_EXTENSION_SECRET>`
**Body field on every request:** `consultantFirstName: string` — must match a name in `src/users.js` (Joel, Alice, Bob, Carol, Dave, Erin). Aliases supported per the registry.

Local MCP responsibilities are minimal:
1. Forward each tool call as `POST /mcp/<tool>` with the headers above.
2. Inject `consultantFirstName` from the consultant config.
3. Return the JSON to Claude verbatim.

Everything else (caching, fuzzy resolution, projection, RF API, snapshot rebuilds) lives server-side.

---

## Endpoints

### `POST /mcp/candidate-search`

**Purpose:** Find candidates by query (fuzzy name) and/or structured filters.

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "query": "jerry",                       // optional — fuzzy name match
  "job": 999,                             // optional — numeric job id
  "stage": "Sourced",                     // optional
  "owner": 900001,                        // optional — numeric RF user id
  "company": "SAP",                       // optional — substring match
  "email": "jerry@example.com",           // optional — exact, case-insensitive
  "technology": ["Kubernetes", "Go"],     // optional — multi-select, ANY match
  "segment": "Enterprise",                // optional — exact custom field
  "role": "AE",                           // optional — exact custom field
  "added_after": "2026-04-01",            // optional — ISO date
  "added_before": "2026-05-01",
  "updated_after": "2026-04-01",
  "updated_before": "2026-05-01",
  "include_disqualified": false,          // default false
  "limit": 5,                             // default 5, max 50
  "fields": ["name", "linkedin"]          // optional — see "Fields" below
}
```

**Default response shape:**
```json
{
  "count": 3,
  "matches": [
    { "id": 49243, "name": "Jane Doe", "score": 0.93 },
    { "id": 50300, "name": "Kevin Park",  "score": 0.91 }
  ]
}
```

`score` is included on fuzzy/scored matches (always present when `query` is set). With `fields`, results include the projected fields too.

**Disambiguation:** never blocks — top-K matches are always returned. Caller decides how to disambiguate.

---

### `POST /mcp/candidate-get`

**Purpose:** Fetch one candidate by id (preferred) or fuzzy name.

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "id": 51507,                            // exactly one of id/query
  "query": "Marcus Delgado",
  "fields": ["name", "linkedin", "company", "email"]
}
```

**Default response (no `fields`):**
```json
{
  "candidate": {
    "id": 51507,
    "first_name": "Eric",
    "last_name": "Stagnaro",
    "primary_email": null,
    "phone_numbers": ["+16105550188"],
    "jobs": [
      { "client_company_name": "Nominal", "job_name": "Enterprise AE - NYC", "stage_name": "Sourced" }
    ]
  }
}
```

**With `fields`:**
```json
{
  "candidate": {
    "name": "Marcus Delgado",
    "linkedin_profile": "marcusdelgado",
    "current_organization": "SAP Taulia",
    "current_title": "Senior Account Executive - SAP Taulia"
  },
  "_meta": {
    "notes": [
      "\"linkedin\" → linkedin_profile",
      "\"company\" → current_organization",
      "\"title\" → current_title",
      "\"email\" → primary_email"
    ]
  }
}
```

**Errors:**
- `400` — missing both `id` and `query`
- `404` — `{ "error": "No match" }`
- `200 + needs_disambiguation: true` — when fuzzy `query` returns top-2 within `UNIQUE_GAP=0.08`. Body shape:
  ```json
  { "needs_disambiguation": true, "options": [{ "id", "name", "score" }] }
  ```

---

### `POST /mcp/candidate-move-stage`

**Purpose:** Move a candidate to a new stage on a job. RF round-trip; no D1 write (sync reconciles within 15 min).

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "candidate": 51507,                     // numeric id only (fuzzy not yet wired)
  "job": 999,                             // optional — defaults to the candidate's single non-DQ job
  "stage": "Replied"                      // stage name OR id
}
```

**Default response:**
```json
{
  "ok": true,
  "moved": {
    "candidate_id": 51507,
    "candidate_name": "Marcus Delgado",
    "job_id": 999,
    "job_name": "Enterprise AE - NYC",
    "from_stage": "Sourced",
    "to_stage": "Replied"
  }
}
```

**Disambiguation** (when candidate is on multiple non-DQ jobs and no `job` specified):
```json
{
  "needs_disambiguation": true,
  "kind": "job",
  "options": [
    { "job_id": 999, "job_name": "Enterprise AE - NYC", "stage_name": "Sourced" },
    { "job_id": 1000, "job_name": "AE - SF", "stage_name": "Sourced" }
  ]
}
```

**Errors:** `400` (candidate must be numeric / job not on candidate / stage not on job), `404` (candidate not found), `502` (RF rejected).

---

### `POST /mcp/candidate-log-interview`

**Purpose:** Create an Interview activity on the RF timeline. Returns a calendar deeplink the recruiter can paste.

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "candidate": 51507,                     // numeric id
  "kind": "1st Interview",                // verbatim — "1st Interview" / "2nd Interview" / "Final Interview" / etc
  "start_time": "2026-05-08T10:00:00+01:00",  // REQUIRED, ISO 8601 with TZ
  "end_time": "2026-05-08T11:00:00+01:00",    // optional, default = start + 60min
  "context": "Asked about prior fintech...\nFollow-up on compensation expectations"  // optional, one bullet per newline
}
```

**Default response:**
```json
{
  "ok": true,
  "activity": { "id": 12345, "candidate_id": 51507, "kind": "1st Interview" },
  "next_step": "Add this interview to your calendar via the link below.",
  "outlook_url": "https://outlook.live.com/calendar/0/deeplink/compose?subject=...",
  "gcal_hint": null                       // present only when consultant.calendarMode is 'gcal' or 'both'
}
```

`gcal_hint` (when present): pre-formed event payload `{ summary, description, start, end, calendarId: "primary", attendees: [] }`. **Attendees always empty** — recruiter-only block.

**Errors:** `400` (missing start_time / candidate not numeric), `404` (candidate not found), `502` (RF rejected).

---

### `POST /mcp/job-pipeline`

**Purpose:** Pipeline view for one job, candidates grouped by stage. **KV-cached** (sync rebuilds every 15 min) — fast.

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "job": 999,                             // numeric id (string name resolution not yet wired)
  "stage": "Sourced",                     // optional — narrow to one stage
  "submitted": false,                     // optional — shortcut: CV Sent → Hired stages only
  "include_closed": false,                // not yet wired
  "fields": ["linkedin", "phone", "email"]
}
```

**Default response:**
```json
{
  "job": { "id": 999, "name": "Enterprise AE - NYC", "client_company_name": "Nominal" },
  "stages": [
    {
      "stage_name": "Sourced",
      "count": 65,
      "candidates": [
        { "id": 5000, "name": "Steve Carlson", "stage_moved": "2026-05-07T16:56:51+0000" }
      ]
    },
    { "stage_name": "Replied", "count": 4, "candidates": [...] }
  ]
}
```

`fields` extends each candidate object — see "Fields" below.

**Errors:** `400` (job not numeric), `404` (unknown job).

---

### `POST /mcp/job-candidates-filter`

**Purpose:** Flat candidate list for one job (vs. `job-pipeline` which groups by stage). Same KV-cached path.

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "job": 999,
  "stage": "Sourced",                     // optional
  "limit": 100,                           // default 100, max 500
  "fields": ["linkedin", "phone"]
}
```

**Default response:**
```json
{
  "job": { "id": 999, "name": "Enterprise AE - NYC" },
  "total": 70,
  "matched": [
    { "id": 5000, "name": "Steve Carlson", "stage_name": "Sourced" }
  ]
}
```

`truncated: true` is added if `total > limit`.

---

### `POST /mcp/cache-status`

**Purpose:** Diagnostic. No external API calls.

**Body:**
```json
{ "consultantFirstName": "Joel" }
```

**Response:**
```json
{
  "candidates_count": 27283,
  "jobs_count": 925,
  "last_tail_sync_at": "2026-05-07T19:00:16.561Z",
  "last_tail_sync_count": 0,
  "minutes_since_last_sync": 8,
  "last_full_rebuild_at": "2026-05-07T18:49:50.685Z",
  "in_flight": null
}
```

`in_flight` is `null`, `"true"` (tail sync running), or `"rebuild:<workflow-id>"`.

---

## Fields — alias resolution

The `fields` array on every read endpoint accepts **any reasonable English-ish name**. `projection.js` resolves each one against:

1. Alias dictionary (e.g. `email`, `linkedin`, `salary`, `tech stack`, `recruiter`).
2. Top-level keys on the candidate body.
3. Custom-field fuzzy match against `custom_fields_by_name.<lowercased>` (e.g. `expected compensation`).

**Common alias examples:**

| You pass | Resolves to |
|---|---|
| `email` | `primary_email` |
| `phone` | `phone_numbers` |
| `linkedin` | `linkedin_profile` |
| `github` | `github_profile` |
| `title` / `role` | `current_title` |
| `company` | `current_organization` |
| `recruiter` / `owner` | `lead_owner` |
| `stage` | `jobs.*.stage_name` |
| `salary` / `expected comp` | `custom_fields_by_name.expected compensation.value` |
| `tech stack` | `custom_fields_by_name.tech stack.value` |
| `industry` / `vertical` | `custom_fields_by_name.sells to (industry).value` |

**Unresolvable names don't fail the call** — they're dropped silently and listed in `_meta.unresolved_fields`. Successful aliases are listed in `_meta.notes` for transparency.

```json
{
  "matches": [...],
  "_meta": {
    "unresolved_fields": ["totally_made_up_field"],
    "notes": ["\"linkedin\" → linkedin_profile"]
  }
}
```

The MCP tool definition presented to Claude should say something like *"`fields` accepts any reasonable name — `email`, `phone`, `linkedin`, `salary`, `tech stack`, `current company`, `stage`. Common defaults are returned without specifying."*

---

## Error envelope

Auth + routing errors share a shape:

| Status | Body | When |
|---|---|---|
| 401 | `{ "ok": false, "error": "auth" }` | Missing or wrong `X-MCP-Token` |
| 403 | `{ "ok": false, "error": "Unknown consultant" }` | `consultantFirstName` not in `users.js` |
| 404 | `{ "ok": false, "error": "not found" }` | Unknown `/mcp/*` path |

Per-handler errors return `{ "error": "..." }` with `400` (bad request) / `404` (not found) / `502` (upstream RF failure).

`needs_disambiguation: true` is **always 200** — it's a successful response that asks the caller to refine.

---

## Operational

### Manual full rebuild

When? Only at deploy time or if cache drifts. The 15-min tail sync handles ongoing freshness.

```
POST https://rf-mcp-cache-sync.example-account.workers.dev/admin/full-rebuild
Header: X-Admin-Token: <ADMIN_SECRET>
```

Returns `202 + { ok: true, workflow_id }` immediately. The Workflow runs in CF; track via dashboard or:
```
GET /accounts/<acct>/workflows/rf-mcp-rebuild/instances/<id>
```

### Tail sync

Cron `*/15 * * * *` on `rf-mcp-cache-sync`. No action needed.

### Snapshots

Sync writes `mcp:pipeline:{jobId}` and `mcp:job-candidates:{jobId}` to KV every cron tick. Reads are KV-fetch + tiny projection. Miss-path falls back to D1.

---

## What the local MCP shouldn't try to do

- **Don't read the D1 binding directly.** The middleware hides D1 — the local MCP is just an HTTP forwarder.
- **Don't do fuzzy resolution client-side.** The middleware's `fuzzy.js` is the source of truth. Pass `query` and let the server score.
- **Don't keep its own caches.** The middleware is fast (KV reads ~10ms, D1 reads ~30ms). Local caching adds drift risk.
- **Don't translate field names.** Pass whatever Claude wrote; the server resolves aliases.
- **Don't loop to handle pagination or rebuild orchestration.** `cache-status` and `/admin/full-rebuild` are the only operational surfaces; everything else is a single round-trip.

---

## End-to-end smoke test (manual curl)

```bash
MCP=<MCP_EXTENSION_SECRET>
BASE=https://rf-dialpad-sync-dev.example-account.workers.dev

# 1. Auth + cache-status
curl -X POST $BASE/mcp/cache-status \
  -H "X-MCP-Token: $MCP" -H "Content-Type: application/json" \
  -d '{"consultantFirstName":"Joel"}'

# 2. Fuzzy candidate search
curl -X POST $BASE/mcp/candidate-search \
  -H "X-MCP-Token: $MCP" -H "Content-Type: application/json" \
  -d '{"consultantFirstName":"Joel","query":"jerry","limit":3}'

# 3. Candidate-get with field aliases
curl -X POST $BASE/mcp/candidate-get \
  -H "X-MCP-Token: $MCP" -H "Content-Type: application/json" \
  -d '{"consultantFirstName":"Joel","id":51507,"fields":["name","linkedin","company"]}'

# 4. Job pipeline
curl -X POST $BASE/mcp/job-pipeline \
  -H "X-MCP-Token: $MCP" -H "Content-Type: application/json" \
  -d '{"consultantFirstName":"Joel","job":999}'
```

If all four return 200 with sensible data, the surface is healthy.

---

## Where things live

- **Source spec:** `docs/archive/specs/2026-05-07-mcp-middleware-design.md`
- **Implementation plan:** `docs/archive/plans/2026-05-07-mcp-middleware.md`
- **Original handover (server-side):** `docs/handoffs/mcp_handover/2026-05-07-mcp-middleware-handover.md`
- **Endpoint code:** `src/mcp/`
- **Sync worker:** `sync-worker/src/`
- **Field aliases:** `src/mcp/projection.js` (`ALIASES` constant)
- **Fuzzy scorer:** `src/mcp/fuzzy.js`
