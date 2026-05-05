# Mobile PWA — Middleware Hand-off

**Date:** 2026-05-06
**Direction:** middleware → PWA agent (you)
**Companion to:**
- `2026-05-01-dialpad-middleware-handoff.md` — `/dialpad-call` and `/dialpad-user-context` shapes
- `2026-05-01-dialpad-sms-middleware-handoff.md` — `/dialpad-sms`
- `2026-05-05-call-state-polling-handoff.md` — `/dialpad-hangup` + `/extension-call-status` polling design (still authoritative)

This doc is everything the mobile PWA needs from the middleware: the two
new PWA-specific endpoints (`/my-sourcing-jobs`, `/job-pipeline`) plus a
self-contained reference for the existing extension routes you'll be
reusing. If the cross-references above contradict anything below, **this
doc wins** for the PWA — the extension docs assume things (Plasmo
background script, LinkedIn URL coming from the page) that don't apply
to your environment.

---

## TL;DR — what you're building against

| Surface | Use |
|---|---|
| `POST /my-sourcing-jobs` (NEW) | Home screen — "MY open sourcing jobs" |
| `POST /job-pipeline` (NEW) | Pipeline view — Sourced candidates for a job, ordered |
| `POST /candidate-details` | Per-candidate sidepanel data |
| `POST /dialpad-user-context` | Caller-ID picker (one-time per session) |
| `POST /dialpad-call` | Initiate a Dialpad call |
| `POST /dialpad-sms` | Send a single SMS |
| `POST /dialpad-hangup` | Hang up the active Dialpad call |
| `POST /extension-call-status` | Poll for call state (in_progress / ended) |
| `POST /candidate-mark-invalid` | Tag candidate `"Number Invalid"` (optional) |

You will **not** use `/candidates` or `/candidates/add-to-job` — those are
extension-only (the extension reads from LinkedIn Recruiter and adds
candidates; the PWA is read-only on the candidate set).

---

## Base URL + auth + CORS

**Base URL:** `https://rf-dialpad-sync-dev.example-account.workers.dev`

(The `-dev` suffix is intentional — single-tenant single-worker, this is
the live URL.)

**Auth:** Every request includes an `X-Extension-Token: <secret>` header.
The secret lives in the build (constant `MIDDLEWARE_SECRET` or similar —
match whatever the extension does). **This is short-term auth.** Anyone
with the APK / a debug attach can extract the token. Long-term plan is
OTP + session-token; you don't need to build that, but don't bake any
"the extension is the only client" assumptions into the structure of
your auth layer.

**Capacitor specifics:**

- **Recommended:** use `CapacitorHttp` plugin for all middleware calls in
  the native (Android) build path. It bypasses CORS entirely (native HTTP,
  doesn't go through the WebView), no preflight, no `Origin` header. More
  reliable than fetch-from-WebView across Android versions.
- **For the web/dev build:** plain `fetch()` works. The middleware sends
  `Access-Control-Allow-Origin: *`, allows `X-Extension-Token` in the
  preflight allow-list, and handles OPTIONS. Capacitor's WebView origins
  (`https://localhost` on Android, `capacitor://localhost` on iOS) are
  both covered by the wildcard.
- **Don't change `androidScheme`.** Default `https` — leaving it alone
  keeps the WebView origin HTTPS so calling our HTTPS worker isn't
  blocked by mixed-content policy.

**Common request envelope:**

```http
POST /<path> HTTP/1.1
Host: rf-dialpad-sync-dev.example-account.workers.dev
Content-Type: application/json
X-Extension-Token: <secret>

{ "consultantFirstName": "Joel", ...other fields... }
```

Every request body includes `consultantFirstName: string`. The middleware
resolves it to an RF user ID and a Dialpad user ID via a hardcoded team
registry (`Joel`, `Alice`, `Bob` (alias `Bob`), `Carol` are the
current entries; case-insensitive, whitespace-trimmed). Unknown name →
**403** `Consultant not found`.

**Common error shapes:**

```json
// 400 — bad input
{ "ok": false, "error": "Missing \"consultantFirstName\"" }

// 401 — wrong/missing X-Extension-Token
{ "ok": false, "error": "Authentication failed" }

// 403 — name not in team registry
{ "ok": false, "error": "Consultant not found" }

// 409 — soft-error (only /dialpad-hangup uses it: no active call)
{ "ok": false, "error": "No active call" }

// 429 — rate limit / dedup (only /dialpad-call)
{ "ok": false, "reason": "rate_limit" | "duplicate", "retryAfterSec": 12, "error": "..." }

// 500 — internal — surface as a generic "something went wrong"
{ "error": "Internal Server Error" }

// 502 — upstream (Dialpad/RF) rejected — surface the message field
{ "ok": false, "error": "Dialpad rejected the call: <upstream msg>" }
```

---

## NEW: `POST /my-sourcing-jobs`

Home-screen list of jobs the consultant is actively sourcing for.

### Request

```json
{ "consultantFirstName": "Joel" }
```

### Response (200)

```json
{
  "jobs": [
    { "id": 980, "name": "Senior Support Engineer", "company": "Eon.io" },
    { "id": 1024, "name": "Senior Frontend Engineer", "company": "Acme Inc" }
  ]
}
```

Empty array `{ "jobs": [] }` if no jobs match — show a "no active sourcing
jobs" empty state.

### Filtering rules (worker-side, you don't need to know these but useful context)

A job appears in the response iff **all** of:
- `is_open: true` (RF's `?only_open=1` filter)
- `hiring_team` contains a member with `user_id === <consultant's RF user ID>` AND `role` (case-insensitive) `=== "Recruiter"`
- `job_status.name` (case-insensitive) `=== "Sourcing"`

If you expect a job to appear and it doesn't, the consultant's RF
user-team membership or the job's status name is the most likely cause.

### Errors

- **400** missing `consultantFirstName`
- **401** auth
- **403** consultant not in registry
- **500** internal — usually means RF API failed; retryable

---

## NEW: `POST /job-pipeline`

Sourced-stage candidates for a single job, ordered for the prev/next traversal.

### Request

```json
{ "consultantFirstName": "Joel", "jobId": 980 }
```

`jobId` accepts integer or numeric string.

### Response (200)

```json
{
  "jobId": 980,
  "stage": "Sourced",
  "total": 23,
  "candidates": [
    {
      "rfId": 12345,
      "linkedinUrl": "https://www.linkedin.com/in/jane-doe-000000000"
    },
    {
      "rfId": 49401,
      "linkedinUrl": "https://www.linkedin.com/in/jane-doe-123"
    }
  ]
}
```

- `total` is RF's count of all matches; should equal `candidates.length`
  in normal use. If they diverge it means RF returned more than the
  paginate-cap of 1000 — flag in logs but don't block the user.
- `candidates` is **already sorted** by `added_time` ascending
  (oldest-added first — surfaces stale candidates that need attention).
  Do **not** re-sort.
- Candidates without a usable LinkedIn URL are filtered out server-side
  (RF returns the literal string `"None"` for missing values; we drop
  those + empty + null).
- LinkedIn URLs are normalized to the canonical
  `https://www.linkedin.com/in/<slug>` form regardless of what RF stored
  (slug-only, full URL, with or without trailing slash). You can pass
  these straight to `/candidate-details` without re-normalizing.

### Use the response

The PWA loads this list once when the user picks a job, then traverses
prev/next over `candidates[i]`. For each card shown, fetch
`/candidate-details` with `profileUrl: candidates[i].linkedinUrl`. The
list itself stays static for the session — refresh only on user pull-down
or job re-open.

### Errors

- **400** missing/invalid `consultantFirstName` or `jobId`
- **401** auth
- **403** consultant not in registry
- **500** internal — RF rejection or network error

---

## REUSED: `POST /candidate-details`

Per-candidate data for the card view.

### Request

```json
{
  "consultantFirstName": "Joel",
  "profileUrl": "https://www.linkedin.com/in/jane-doe-000000000"
}
```

`profileUrl` accepts a full URL, a `linkedin.com/in/<slug>` form, or a
bare slug — the middleware normalizes.

### Response (200)

```json
{
  "rfId": 12345,
  "fullName": "Jane Doe",
  "phoneNumber": "+447700900123",
  "job": {
    "id": 980,
    "title": "Senior Support Engineer",
    "company": "Eon.io",
    "stageName": "Sourced"
  },
  "activities": [
    {
      "id": 12345,
      "outcome": "connected",
      "description": "Next steps:\n- Schedule follow-up call",
      "createdAt": "2026-04-30T14:23:00Z"
    }
  ]
}
```

- `phoneNumber` is E.164. May be empty string if RF has none.
- `job` is the consultant's own job for this candidate (disambiguated
  via the cached `consultant_id` custom field). May be `null` if the
  candidate has no jobs the consultant added them to. For the PWA, you
  pass the same `jobId` from `/job-pipeline` so this should always
  resolve.
- `activities` is **only** type-1002 cold-call activities, sorted
  oldest-first. Use this to render the "previous calls" feed on the
  card.

### Errors

- **400** missing `profileUrl`
- **401** auth
- **403** consultant not in registry
- **404** `Candidate not found in RF` — candidate exists nowhere in RF;
  show a "candidate not in RF" empty state
- **500** internal

### Performance

- First fetch ~200-600ms (one RF GET + one activities-list GET, in
  parallel).
- Subsequent fetches for the same candidate within 20 minutes are <50ms
  (KV cache hit).
- The middleware fires a fire-and-forget "neighbor prewarm" — pre-fetches
  the next ~30 candidates' details in the background. As long as the user
  walks through the pipeline at human speed, every card after the first
  is a cache hit.

---

## REUSED: `POST /dialpad-user-context`

Caller-ID picker. Call this **once** per session (or when the user
navigates to the call UI for the first time). The result is stable for
the consultant's account — cache it locally.

### Request

```json
{ "consultantFirstName": "Joel" }
```

### Response (200)

```json
{
  "callerIds": [
    {
      "aliasId": "eyJhbGc...",   // opaque JWT, ~7-day TTL
      "country": "UK",            // "UK" | "US" | "OTHER"
      "label": "Joel — Mobile",
      "isDefault": true
    },
    {
      "aliasId": "eyJhbGc...",
      "country": "US",
      "label": "Sales — NYC office",
      "isDefault": false
    }
  ]
}
```

- `aliasId` is **opaque** — never decode, never log, never display the
  underlying number. Pass it back verbatim to `/dialpad-call` and
  `/dialpad-sms`. The actual E.164 number lives only on the worker.
- `country` is derived from the underlying number's `+` prefix — for
  flag/grouping UI.
- `label` is the human-readable description (e.g., "Joel — Mobile",
  "Sales — NYC office").
- `isDefault: true` on at most one entry — the consultant's chosen
  default sender. Pre-select this in the picker.
- Aliases expire after ~7 days. If `/dialpad-call` returns 400 with
  `error` matching `/caller/i`, refresh the list.

### Errors

- **400** missing `consultantFirstName`
- **403** consultant not in registry
- **500** internal — usually Dialpad rejection

---

## REUSED: `POST /dialpad-call`

Initiate a call. The user's phone (whichever Dialpad-app device is
eligible) rings — Dialpad picks the device, we don't.

### Request

```json
{
  "consultantFirstName": "Joel",
  "phoneNumber": "+447700900123",
  "callerAliasId": "eyJhbGc..."
}
```

### Response (200)

```json
{ "ok": true }
```

That's the whole successful response — no `callId`. The middleware holds
it; you'll see `state: "in_progress"` from `/extension-call-status`
shortly.

### Errors

- **400** — missing/invalid phoneNumber, missing/invalid callerAliasId,
  expired alias, missing consultantFirstName
- **401** — auth
- **403** — consultant not in registry
- **429** — rate limit (5 calls/60s rolling) OR dedup (same number
  dialled within 3s). Body includes `reason: "rate_limit" | "duplicate"`,
  `retryAfterSec`. Show the wait time and re-enable the Call button when
  the timer elapses.
- **502** — Dialpad rejected (no autocallable device, bad number,
  account issue). Body's `error` field has the upstream message —
  surface it to the user verbatim.

---

## REUSED: `POST /dialpad-sms`

Send one SMS.

### Request

```json
{
  "consultantFirstName": "Joel",
  "phoneNumber": "+447700900123",
  "callerAliasId": "eyJhbGc...",   // OPTIONAL — omit to use Dialpad default sender
  "text": "Hi Tony — saw your background, would love a quick chat..."
}
```

- `text` is sent **verbatim** — leading/trailing whitespace, newlines,
  emoji all preserved. Don't trim.
- `callerAliasId` is optional; without it Dialpad picks the consultant's
  default SMS-capable number.

### Response (200)

```json
{ "ok": true, "messageId": "sms-12345" }
```

`messageId` may be absent if Dialpad doesn't return one.

### Errors

- **400** — missing/empty text after trim, missing phoneNumber, bad
  alias
- **401** / **403** — auth / registry
- **502** — Dialpad rejected — surface upstream message. **Do NOT
  auto-retry** — risk of double-send. Preserve the user's text in the
  composer so they can hit send again manually.

### Notes

- No rate-limit or dedup gate on SMS yet (single-tenant, low volume).
  Don't rely on the worker to throttle — if you want client-side
  throttling that's your call.

---

## REUSED: `POST /extension-call-status`

Poll while a call is active. The worker's call-state model is
**webhook-driven, eventually consistent**. The Dialpad webhook
(`calling` + `hangup` events) is the only thing that writes/clears the
worker's per-user `call_id` KV — `/dialpad-call` and `/dialpad-hangup`
don't touch it. So between hitting `/dialpad-call` and seeing
`{state:"in_progress"}` from this endpoint, expect a brief delay
(typically a few hundred ms, occasionally up to a couple of seconds)
while Dialpad delivers the `calling` webhook.

### Request

```json
{ "consultantFirstName": "Joel" }
```

### Response (200)

```json
{ "state": "in_progress" }
```

or

```json
{ "state": "ended" }
```

That's the whole shape. No `callId`, no `phoneNumber`, no other fields.

### Polling pattern

```
1. User taps Call → POST /dialpad-call. On 200:
     - Show "Calling…" disabled button
     - Start a 10-second clock
     - Begin polling /extension-call-status every ~500ms
2. Polling response { state: "in_progress" }:
     - Flip button to red "Hangup", enabled
     - Cancel the 10-second clock
     - Keep polling
3. Polling response { state: "ended" } **while button is "Hangup"**:
     - Flip back to "Call"
     - Stop polling
4. Polling response { state: "ended" } **while still "Calling…"**:
     - Keep polling (don't give up yet — the calling webhook may just
       not have landed)
     - Only the 10-second clock decides "give up"
5. 10-second clock fires while still "Calling…" without ever seeing
   in_progress:
     - Flip back to "Call"
     - Stop polling
     - Surface a soft "couldn't confirm the call started" error
```

### Errors

- **400 / 401 / 403** — input or auth
- **500** — internal — treat as transient, keep polling

### Polling cadence + cost

- 500ms is the recommended cadence. Faster gains nothing.
- Pure KV read on the worker side, no Dialpad call per poll, very
  cheap. Don't worry about polling cost.

---

## REUSED: `POST /dialpad-hangup`

End the active call.

### Request

```json
{ "consultantFirstName": "Joel" }
```

That's the whole body. No `callId` — the worker reads it from KV.

### Response (200)

```json
{ "ok": true }
```

### Errors

- **400 / 401 / 403** — input or auth
- **409** — `No active call` — the worker has no `call_id` for this
  user. Means either the user clicked Hangup before the calling webhook
  landed, OR the call already ended and the hangup webhook cleared KV.
  Treat as a soft error — flip the button back to "Call", surface a
  brief "couldn't hang up — call may have ended already" message. Don't
  block the UI.
- **502** — Dialpad rejected (call already terminated, etc.). Treat the
  same as 200 for UX purposes.

### Polling interaction

`/dialpad-hangup` does NOT clear KV — the resulting Dialpad `hangup`
webhook is the single source of truth for clearing. So:

- After a successful `/dialpad-hangup` (200), polling may briefly still
  return `in_progress` for one or two more polls until the hangup
  webhook lands.
- You can either: (a) flip to "Call" immediately on the 200 and stop
  polling, OR (b) keep polling until you see `{state:"ended"}`. Either
  works. (a) is the better UX — user gets instant feedback.

---

## REUSED: `POST /candidate-mark-invalid` (optional)

If you want a "mark this number invalid" affordance on the card, this
endpoint tags the candidate with `"Number Invalid"` in RF and
invalidates the worker's details/activities cache.

### Request

```json
{ "consultantFirstName": "Joel", "rfId": 12345 }
```

Or, if you have only the LinkedIn URL:

```json
{ "consultantFirstName": "Joel", "profileUrl": "https://www.linkedin.com/in/..." }
```

### Response (200)

```json
{ "ok": true, "alreadyTagged": false }
```

`alreadyTagged: true` means the candidate already had the tag — no RF
write happened, idempotent.

### Errors

- **400 / 401 / 403** — input or auth
- **404** — candidate not found
- **500** — RF rejection

---

## Typical PWA session lifecycle

```
1. App launches
   → Read X-Extension-Token + consultantFirstName from local config
2. Home screen mounts
   → POST /my-sourcing-jobs { consultantFirstName }
   → Render job list
3. User taps a job
   → POST /job-pipeline { consultantFirstName, jobId }
   → Render the candidate list (each row: just an index + linkedinUrl)
   → Cache the list locally for the session
4. User taps the first candidate (or "start cold-calling")
   → POST /dialpad-user-context { consultantFirstName }   (once)
   → Cache callerIds locally
   → POST /candidate-details { consultantFirstName, profileUrl: list[0].linkedinUrl }
   → Render the card
5. User taps Call
   → POST /dialpad-call { consultantFirstName, phoneNumber, callerAliasId }
   → On 200: Calling…, start polling /extension-call-status, start 10s clock
   → On in_progress: button → Hangup
   → On ended (post-Hangup) OR 10s timeout: button → Call, stop polling
6. User taps Hangup
   → POST /dialpad-hangup { consultantFirstName }
   → On 200: button → Call, stop polling
7. User taps Next
   → POST /candidate-details for list[i+1].linkedinUrl
   → Render the next card
8. User taps SMS (optional)
   → Show composer with optional caller-ID picker
   → POST /dialpad-sms { consultantFirstName, phoneNumber, callerAliasId?, text }
9. User backs out / closes
   → No teardown needed — the worker is stateless from this side
```

---

## Gotchas

1. **Don't open SSE.** The `/extension-call-stream` endpoint from the
   2026-05-01 doc is **gone**. Polling only. If the older extension
   handover talks about EventSource, that's obsolete.

2. **Don't store `call_id` anywhere.** It never appears in any response
   you'll get. Hangup is by `consultantFirstName` only.

3. **The "Calling…" buffer is mandatory.** Don't make the Hangup button
   clickable until the first `{state:"in_progress"}` response. Clicking
   Hangup before that returns 409 — recoverable but ugly UX.

4. **Don't auto-retry SMS.** A 502 might mean Dialpad accepted but the
   confirmation timed out — auto-retry could double-send. Preserve the
   text in the composer and let the user decide.

5. **Caller-ID aliases are short-lived.** ~7-day TTL on the JWT. If
   `/dialpad-call` 400s with a "caller" error, refresh
   `/dialpad-user-context` and retry.

6. **`consultantFirstName` is case-insensitive but must match the
   registry.** Currently `Joel`, `Alice`, `Bob` (alias `Bob`),
   `Carol`. Spelling errors → 403. If the PWA has a "who are you"
   onboarding step, validate against the registry by hitting
   `/my-sourcing-jobs` once and treating 403 as "not a recognized
   consultant".

7. **Dialpad webhook delivery isn't 100% reliable** (per the call-state
   handoff). Most of the time the calling event lands within ~500ms;
   occasionally it doesn't land at all. Your 10-second timeout is the
   recovery path. Don't try to be clever — let it fall through and the
   user re-tries.

8. **Polling driver lifetime.** Tie the polling loop to the screen that
   shows the call button. If the user navigates away, stop polling.
   `setInterval` + cleanup on unmount. No background-task polling, no
   service-worker polling — the worker's `call_id` will TTL out at 20
   min anyway.

9. **No retry-with-backoff on /candidate-details.** If it 500s, fail
   the card with an error state and let the user retry manually. The
   neighbor-prewarm fires async and will warm subsequent cards
   regardless.

10. **CORS in dev (browser).** The middleware serves
    `Access-Control-Allow-Origin: *`. Works for `localhost:*`,
    `127.0.0.1:*`, Capacitor's WebView origins. If you ever hit a CORS
    error, it's almost certainly a different problem (e.g., bad URL,
    HTTP-vs-HTTPS, missing `X-Extension-Token` triggering 401 before
    CORS responds) — check the actual response status, not just the
    CORS-flavored error in the console.

11. **Auth posture.** The `X-Extension-Token` is bundled into the APK.
    Don't pretend otherwise — log statements that strip it, secret-
    rotation flows, etc., are pointless. The right long-term fix is
    OTP + session-token, not in scope for this build.

---

## Quick sanity-check checklist

Before wiring up your first screen:

- [ ] `curl -X POST -H 'X-Extension-Token: <secret>' -H 'Content-Type: application/json' -d '{"consultantFirstName":"Joel"}' https://rf-dialpad-sync-dev.example-account.workers.dev/my-sourcing-jobs` returns a `jobs` array.
- [ ] Same call without the `X-Extension-Token` header returns 401.
- [ ] `consultantFirstName: "Nobody"` returns 403.
- [ ] `/job-pipeline` with a real `jobId` returns `candidates`.
- [ ] `/candidate-details` with one of those `linkedinUrl`s returns
      `rfId, fullName, phoneNumber, job, activities`.

Hit those four checkpoints in `curl` first, then start building UI
against them.

---

## Out of scope for the PWA

- Adding candidates (extension-only — `/candidates`,
  `/candidates/add-to-job`)
- Any RF-webhook-driven flows (calendar, Krisp, cold-call detection
  itself — those are middleware-internal)
- Apollo enrichment (handled server-side)
- The OTP + session-token auth flow (separate effort, talk to Joel
  before building)
