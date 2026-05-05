# Mobile PWA — Middleware Hand-off

**Date:** 2026-05-06
**Direction:** middleware → PWA build

You're porting the extension code, so most middleware integration carries
over verbatim — same `X-Extension-Token` header, same
`consultantFirstName` body field, same response shapes. This doc only
covers the **deltas**: two new endpoints, Capacitor specifics, and the
one structural thing that changes (where profile URLs come from).

For everything else (`/candidate-details`, `/dialpad-user-context`,
`/dialpad-call`, `/dialpad-sms`, `/dialpad-hangup`,
`/extension-call-status`, `/candidate-mark-invalid`), copy the
extension's request/response handling. The most recent call-state design
is in `docs/handoffs/2026-05-05-call-state-polling-handoff.md` — it
supersedes the 2026-05-01 SSE doc.

---

## Base URL + auth

`https://rf-dialpad-sync-dev.example-account.workers.dev` — every request
includes `X-Extension-Token: <secret>` (same secret as the extension)
and a body with `consultantFirstName`.

Currently registered consultants: `Joel`, `Alice`, `Bob` (alias `Bob`),
`Carol`. Case-insensitive, whitespace-trimmed. Unknown name → 403.

---

## Capacitor

- **Use `CapacitorHttp` plugin for native (Android) build.** Bypasses
  CORS entirely (native HTTP, doesn't go through the WebView). Cleaner
  than fetch-from-WebView and avoids preflight quirks.
- **Web/dev build:** plain `fetch()` works. Worker sends
  `Access-Control-Allow-Origin: *` and allows `X-Extension-Token` in
  preflight, so Capacitor's WebView origins are fine.
- **Don't change `androidScheme`** — leave the default `https`. If it
  flips to `http` you'll hit Android mixed-content blocking on our
  HTTPS worker.

---

## NEW: `POST /my-sourcing-jobs`

Home-screen list of jobs the consultant is actively sourcing for.

**Request:**
```json
{ "consultantFirstName": "Joel" }
```

**Response (200):**
```json
{
  "jobs": [
    { "id": 980, "name": "Senior Support Engineer", "company": "Eon.io" }
  ]
}
```

**Filtering** (worker-side): `is_open: true` AND `hiring_team` contains
the consultant with `role === "Recruiter"` (case-insensitive) AND
`job_status.name === "Sourcing"` (case-insensitive). Empty `jobs: []`
if nothing matches.

**Errors:** 400 missing `consultantFirstName`, 401 auth, 403 unknown
consultant, 500 RF rejection (treat as transient).

---

## NEW: `POST /job-pipeline`

Sourced-stage candidates for a single job, ordered for prev/next traversal.

**Request:**
```json
{ "consultantFirstName": "Joel", "jobId": 980 }
```

**Response (200):**
```json
{
  "jobId": 980,
  "stage": "Sourced",
  "total": 23,
  "candidates": [
    { "rfId": 12345, "linkedinUrl": "https://www.linkedin.com/in/jane-doe-000000000" }
  ]
}
```

- **Already sorted** by `added_time` ASC (oldest first). Don't re-sort.
- Candidates without a usable LinkedIn URL are filtered out server-side.
- `linkedinUrl` is normalized to canonical
  `https://www.linkedin.com/in/<slug>` form — pass straight to
  `/candidate-details` without re-normalizing.
- Capped at 1000 candidates per response. If `total > candidates.length`
  log it but don't block.

**Errors:** 400 missing/invalid `jobId`, 401 / 403 same as above, 500
RF rejection.

---

## The structural delta vs the extension

**Where the LinkedIn URL comes from changes.** In the extension, the
content script scrapes LinkedIn Recruiter pages — every per-candidate
fetch starts from the page URL. In the PWA, you load the URL list once
from `/job-pipeline` at the start of a session, then iterate locally
with prev/next, calling `/candidate-details` with each `linkedinUrl`.

Otherwise the candidate-details / call / SMS / hangup / status loops
are identical to the extension. Same shapes, same auth, same polling
pattern.

---

## Out of scope for the PWA

- Adding candidates (`/candidates`, `/candidates/add-to-job`) — extension-only.
- Any RF/Calendar/Krisp webhook flows — middleware-internal.
- OTP / session-token auth — separate effort.
