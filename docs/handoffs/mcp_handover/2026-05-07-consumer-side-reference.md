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

> **Names, not ids.** The middleware resolves `candidate`, `job`, `stage`, and `owner` references on every endpoint that accepts them — pass a string and the worker fuzzy-matches it server-side. Numeric ids still work as a fallback. See "Ambiguity / disambiguation" near the end of this doc for the standard envelope when a name resolves to multiple candidates.

> **Open jobs only.** Fuzzy job resolution defaults to `is_open=1`. Closed jobs are reachable only by explicit numeric id — recruiters typing a job name almost never mean a closed one. Same idea applies to candidate fuzzy: the recency boost weights the last 30 days heavily, so the Jerry you spoke to last week wins outright over a Jerry from two months ago.

> **Lean envelopes.** Disambiguation responses are deliberately minimal — just enough to render distinct lines and pick a winner. Never expect full bodies in `options[]`. If you need more detail on a candidate, follow up with `candidate-get`.

> **Post-narrow on writes.** `candidate-move-stage` and `candidate-log-interview` enumerate every valid `(candidate, job, stage?)` tuple before deciding. When fuzzy-candidate is ambiguous but only one match also has the requested job/stage, the worker auto-commits — no disambiguation round-trip. When ≥2 valid tuples remain, the `kind` is the smallest level of variation across them (candidates differ → `candidate`, same candidate but jobs differ → `job`, etc.).

---

## Endpoints

### `POST /mcp/candidate-search`

**Purpose:** Find candidates by query (fuzzy name) and/or structured filters.

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "query": "jerry",                       // optional — fuzzy name match
  "job": "Enterprise AE",                 // optional — numeric id OR fuzzy job name (acronyms folded: "SE" ↔ "Sales Engineer")
  "stage": "sourced",                     // optional — fuzzy when `job` is set ("sourced" → "Sourced", "1st" → "1st Interview")
  "owner": "Joel",                        // optional — RF user id, our-team first name, or fuzzy full-name
  "company": "SAP",                       // optional — substring match
  "email": "jerry@example.com",           // optional — exact, case-insensitive
  "technology": ["kubernetes", "go"],     // optional — multi-select, ANY match; fuzzy + case-insensitive
  "segment": "enterprise",                // optional — fuzzy + case-insensitive against custom field options
  "role": "ae",                           // optional — fuzzy + case-insensitive against custom field options
  "added_after": "2026-04-01",            // optional — ISO date
  "added_before": "2026-05-01",
  "updated_after": "2026-04-01",
  "updated_before": "2026-05-01",
  "include_disqualified": false,          // default false
  "limit": 5,                             // default 5, max 50
  "fields": ["name", "linkedin"]          // optional — see "Fields" below
}
```

`job`, `owner`, `stage` (when `job` is also set), and the custom-field filters (`technology[]`, `segment`, `role`) all accept fuzzy strings; ambiguous resolutions return `needs_disambiguation` (see envelope below). `not_found` resolutions fall through to literal exact-match SQL — unknown values produce `count: 0` rather than an error.

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
  "candidate": "Jane Doe",              // numeric id, "42" digit-string, OR fuzzy name
  "job": "Enterprise AE",                 // optional — numeric id OR fuzzy name within the candidate's jobs[]
  "stage": "call booked"                  // numeric id OR fuzzy name ("call booked" → "Call Booked", "1st" → "1st Interview")
}
```

All three references are fuzzy-resolvable. Resolution runs sequentially and short-circuits on the **first** ambiguous step — if `candidate` is ambiguous you'll get `kind: "candidate"` options without the worker even looking at `job`/`stage`.

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

**Disambiguation** envelopes — same shape across `candidate`, `job`, `stage`:

```json
// Ambiguous candidate (e.g. candidate: "Jerry" with two Jerries):
{
  "needs_disambiguation": true,
  "kind": "candidate",
  "options": [
    { "id": 1, "name": "Jane Doe", "score": 0.92, "current_organization": "Acme",   "current_title": "AE" },
    { "id": 2, "name": "Kevin Park",  "score": 0.91, "current_organization": "Globex", "current_title": "CSM" }
  ],
  "hint": "Multiple candidates match \"jerry\" — please be more specific."
}

// Ambiguous job (legacy "candidate has multiple non-DQ jobs and no job specified" path):
{
  "needs_disambiguation": true,
  "kind": "job",
  "options": [
    { "job_id": 999,  "job_name": "Enterprise AE - NYC", "stage_name": "Sourced" },
    { "job_id": 1000, "job_name": "AE - SF",             "stage_name": "Sourced" }
  ]
}

// Ambiguous stage (e.g. stage: "Interview" matches both "1st Interview" and "2nd Interview"):
{
  "needs_disambiguation": true,
  "kind": "stage",
  "options": [
    { "id": 4, "name": "1st Interview", "score": 0.85 },
    { "id": 5, "name": "2nd Interview", "score": 0.85 }
  ],
  "hint": "Multiple stages match \"interview\" — please be more specific."
}
```

**Errors:** `400` (job not on candidate / stage not on job / candidate empty), `404` (candidate not found), `502` (RF rejected).

---

### `POST /mcp/candidate-log-interview`

**Purpose:** Create an Interview activity on the RF timeline. Returns a calendar deeplink the recruiter can paste.

**Body:**
```json
{
  "consultantFirstName": "Joel",
  "candidate": "Marcus Delgado",           // numeric id, digit-string, OR fuzzy name
  "job": "Enterprise AE",                 // optional — numeric id OR fuzzy name within candidate's jobs[]
  "kind": "1st Interview",                // verbatim — "1st Interview" / "2nd Interview" / "Final Interview" / etc
  "start_time": "2026-05-08T10:00:00+01:00",  // REQUIRED, ISO 8601 with TZ
  "end_time": "2026-05-08T11:00:00+01:00",    // optional, default = start + 60min
  "context": "Asked about prior fintech...\nFollow-up on compensation expectations"  // optional, one bullet per newline
}
```

`candidate` and `job` go through the same resolver as `candidate-move-stage`; ambiguous names return `needs_disambiguation` (200) with the standard envelope.

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
  "job": "Enterprise AE",                 // numeric id OR fuzzy job name (acronyms folded)
  "stage": "sourced",                     // optional — fuzzy single-stage filter, resolved against this job's populated stages. When set, takes precedence over from/to/submitted/default.
  "from": "replied",                      // optional — fuzzy lower bound, resolved against THIS JOB'S pipeline. "from: 'Replied'" → Replied through end of pipeline.
  "to": "1st",                            // optional — fuzzy upper bound, same pipeline. "to: '1st Interview'" → start through 1st Interview. Combine with `from` for a custom range.
  "submitted": false,                     // optional — shortcut: CV Sent → end of this job's pipeline.
  "include_closed": false,                // not yet wired
  "fields": ["linkedin", "phone", "email"]
}
```

Ambiguous job names return the standard `needs_disambiguation: true, kind: "job"` envelope. Ambiguous `from`/`to` (e.g. `from: "interview"` against a pipeline with multiple Interview stages) returns the same envelope with `kind: "stage"`.

**Default range** when none of `stage`, `from`, `to`, or `submitted` is set: **CV Sent → Offer**, fuzzy-resolved against **this job's** pipeline. Sourced and Replied are usually noise to recruiters glancing at a job — pass `from: "Sourced"` (or any earlier stage) to widen. Different jobs have different pipelines (some include Phone Screen, Take-home, etc); the resolver matches landmarks against whatever pipeline this specific job has, falling back gracefully when a landmark isn't present.

**Default response:**
```json
{
  "job": { "id": 999, "name": "Enterprise AE - NYC", "client_company_name": "Nominal" },
  "stages": [
    {
      "stage_name": "CV Sent",
      "count": 12,
      "candidates": [
        { "id": 5000, "name": "Steve Carlson", "stage_moved": "2026-05-07T16:56:51+0000" }
      ]
    },
    { "stage_name": "1st Interview", "count": 4, "candidates": [...] }
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
  "job": "Enterprise AE",                 // numeric id OR fuzzy job name
  "stage": "sourced",                     // optional — fuzzy + case-insensitive; resolves against this job's stage_names. Ambiguity returns the standard envelope (kind: "stage").
  "limit": 100,                           // default 100, max 500
  "fields": ["linkedin", "phone"]
}
```

Ambiguous job names return `needs_disambiguation` (kind: "job").

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

## Ambiguity / disambiguation

Every endpoint that accepts a `candidate`, `job`, `stage`, or `owner` reference can return a disambiguation response when the user's name resolves to multiple candidates within `UNIQUE_GAP=0.08` of each other. **All such responses are HTTP 200** — disambiguation is a successful response asking the caller to refine, not an error.

### Standard envelope

```json
{
  "needs_disambiguation": true,
  "kind": "candidate" | "job" | "stage" | "owner",
  "options": [
    { "id": 123, "name": "...", "score": 0.92, "...kindSpecific": "..." }
  ],
  "hint": "Multiple candidates match \"john\" — please be more specific."
}
```

The kind-specific extras on each option:

| `kind` | extras |
|---|---|
| `candidate` | `current_organization`, `current_title` |
| `job` | `client_company_name` (or legacy `job_id` / `job_name` / `stage_name` shape from candidate-move-stage's "multiple non-DQ jobs" path) |
| `stage` | (none — just `id`, `name`, `score`) |
| `owner` | `email` |

### How resolution sequences

`/mcp/candidate-move-stage` resolves three references in order — `candidate` → `job` → `stage` — and returns disambiguation at the **first** ambiguous step, never aggregated. If `candidate: "Jerry"` is ambiguous you get `kind: "candidate"` options; only after the consumer disambiguates and retries does the worker even look at `job`/`stage`.

### What the consumer should do

The local MCP can either:

1. **Auto-narrow.** Re-issue the same request with a more specific reference (e.g. `"Jane Doe"` instead of `"Jerry"`).
2. **Surface the options.** Render the `options[]` to the user and let them pick. Each option has `id` — pass that back as the next request's reference field.

Don't blindly pick the first option — the whole point of disambiguation is that the worker isn't sure.

### What it doesn't mean

`needs_disambiguation: true` is **not** "no match". A "no match" outcome is a `400` (filter we couldn't apply) or `404` (entity didn't exist). Disambiguation specifically means "we found ≥2 plausible matches".

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
- **Entity resolvers:** `src/mcp/resolvers.js` (resolveCandidate / resolveJob / resolveStage / resolveOwner)
