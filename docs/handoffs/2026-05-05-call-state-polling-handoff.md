# Dialpad Call State — Polling Rewrite Hand-off (Middleware → Extension)

**Date:** 2026-05-05 (worker simplification update: 2026-05-06)
**Direction:** middleware → extension
**Supersedes:** `2026-05-01-dialpad-call-state-handoff.md` (the SSE design — every
piece of that doc is now obsolete; you're tearing it out)
**Companion to:** `2026-05-01-dialpad-middleware-handoff.md` and
`2026-05-01-dialpad-sms-middleware-handoff.md` (still current; same
auth/CORS/`consultantFirstName` conventions apply)

> **Architecture update (2026-05-06):** The worker side has been simplified
> — the request-driven endpoints (`/dialpad-call`, `/dialpad-hangup`,
> `/extension-call-status`) no longer touch KV at all. The Dialpad
> `calling` and `hangup` webhooks are the **only** path that writes/clears
> the per-user `call_id`. Polling is a pure KV read; "Calling…" buffer is
> now waiting for the calling webhook to land (typically a few hundred ms),
> not for list-calls discovery. **Nothing in the extension contract below
> changes** — same endpoints, same request/response shapes, same
> `{state: "in_progress" | "ended"}` polling response, same 10s give-up
> clock. The internal mechanism is just simpler now and more resilient to
> the eventual-consistency edges that broke discovery via list-calls.

---

## TL;DR — what's changing

We're ripping out the live SSE call-state stream and replacing it with
extension-driven polling. Three things on your side:

1. **Delete every `EventSource(/extension-call-stream)` line.** That endpoint
   is gone (404 from the worker).
2. **Add a polling loop** against new `POST /extension-call-status` while a
   call is in flight (~500ms cadence).
3. **Tweak the button state machine** — only two state values come back from
   the worker now (`in_progress`, `ended`); you collapse to a 3-state UX
   (`Call` / `Calling…` / `Hangup`).

`/dialpad-call`, `/dialpad-hangup`, `/dialpad-sms`, `/dialpad-user-context`
keep the same request bodies and auth. Two minor response-shape notes
below — neither is breaking.

---

## UX philosophy — read this before you start

This feature is a **nice-to-have**. We are explicitly NOT trying to build a
crash-proof, navigation-resilient call-state UI. Scope:

- **Page-stable end-to-end works** — user opens a profile, clicks Call, sees
  Hangup, clicks Hangup (or hangs up via Dialpad app), button reverts. As
  long as nothing changes on the user's end (no nav, no tab switch, no
  reload), the loop should be reliable.
- **Cross-navigation does not need to be durable.** If the user navigates
  to a different LinkedIn profile mid-call, just reset the button to `Call`
  in the new view. Don't try to rehydrate "there's a call in progress
  elsewhere" state on the new page.
- **No persistent-state engineering.** No `chrome.storage`, no service-worker
  state machine, no `BroadcastChannel` fan-out across tabs. Polling state
  lives in whatever component renders the button. If the component
  unmounts, polling stops — that's fine.
- **No background-script polling.** Keep the polling loop scoped to the
  visible button's lifetime. If the button isn't on screen, we don't need to
  know the call state.

The middleware does the heavy lifting (KV-cached `call_id`, hangup webhook,
discovery via Dialpad's call-list). Your job is just to poll while the
button is visible.

If a future iteration wants nav-durable state, that's a separate effort.

---

## What you're being asked to build

1. **Replace the `EventSource(/extension-call-stream)` setup with a
   `setInterval`/`fetch` polling loop** against
   `POST /extension-call-status`, started after a successful `/dialpad-call`
   and stopped when state goes `ended` (or the user clicks Hangup
   successfully, or the button unmounts).
2. **A short "Calling…" disabled-button phase** between the user clicking
   Call and the middleware confirming the call landed in Dialpad. Hangup
   must NOT be clickable during this phase — see "Why the Calling… buffer
   matters" below. Up to ~10 seconds, ending as soon as the first
   `in_progress` polling response arrives.
3. **Fall back to `Call`** if `in_progress` never arrives within 10 seconds
   of the `/dialpad-call` 200. Treat as failed, surface a soft "couldn't
   confirm the call started" message.
4. **No more SSE.** Delete the consumer entirely.

---

## The state machine

Three button states; transitions driven by polling responses + click events.

| State | Button label | Clickable? | How you enter |
|---|---|---|---|
| `Call` | **Call** | yes | Initial. Also re-entered on any terminal path: 200 from `/dialpad-hangup`, polling returns `{state:"ended"}` after we've been `Hangup`, polling never reaches `in_progress` within 10s, `/dialpad-call` returns non-2xx. |
| `Calling…` | **Calling…** (greyed/disabled) | **no** | Entered the moment `/dialpad-call` returns 200. Exits when polling first returns `{state:"in_progress"}` (→ `Hangup`) or after 10s with no `in_progress` (→ `Call`). |
| `Hangup` | **Hangup** (red, enabled) | yes | Entered on the first `{state:"in_progress"}` polling response. |

The `Calling…` phase is **mandatory and load-bearing** — see next section.

### Why the `Calling…` buffer matters

The middleware doesn't know Dialpad's `call_id` until it appears in
Dialpad's call-list, which can lag the `/dialpad-call` response by a few
hundred ms to a couple of seconds. During that window, `/dialpad-hangup`
will return **409 No active call** because the worker has nothing to hang
up.

If the Hangup button is clickable during this window, a fast click will
hit 409 and look broken. Hence: button must NOT be clickable until
polling has confirmed `in_progress`. Once you've seen `in_progress` even
once, `call_id` is bound in middleware KV and Hangup will work.

The middleware does NOT enforce a fixed 2-second timer or anything similar.
The buffer ends as soon as the polling response says `in_progress`, which
may be 300ms or 2s depending on Dialpad list-calls latency.

---

## Endpoint contracts

### `POST /extension-call-status` (new)

Polled every ~500ms while the button is `Calling…` or `Hangup`. Stop polling
once the button is back to `Call`.

```http
POST /extension-call-status HTTP/1.1
Host: <MIDDLEWARE_URL host>
Content-Type: application/json
X-Extension-Token: <per-user secret>

{ "consultantFirstName": "Joel" }
```

**Auth:** `X-Extension-Token` header — same shared secret as every other
extension route.

**Response (200):**

```json
{ "state": "in_progress" }
```

or

```json
{ "state": "ended" }
```

That's the entire response shape. No `callId`, no `phoneNumber`, no other
fields. The extension already knows what it dialled; the worker holds the
`call_id`.

**State semantics:**

| Worker returns | Means |
|---|---|
| `{ state: "in_progress" }` | The middleware is tracking a live outbound call for this user. Button should be `Hangup` (or transitioning out of `Calling…` if this is the first one we've seen). |
| `{ state: "ended" }` | No active call (KV empty or already-terminated). Button should go back to `Call` — but see the 10s rule below. |

**The 10-second rule on the extension side.** The middleware will return
`{state:"ended"}` in two distinct situations and you can't tell them apart
from a single response:

- **(a)** Discovery hasn't started yet (extremely brief — first poll arrives
  before `/dialpad-call`'s KV write commits, basically never happens but
  possible).
- **(b)** Discovery is failing because Dialpad's call-list never reflected
  the call.
- **(c)** The call genuinely ended (user clicked Hangup, Dialpad webhook
  fired, webhook can't fire because subscription not configured, etc.).

To distinguish, treat `{state:"ended"}` differently based on which UX state
you're in:

- **In `Calling…`:** start a 10-second clock from `/dialpad-call`'s 200
  response. Keep polling. If `in_progress` arrives before 10s elapses, flip
  to `Hangup` and reset the clock. If 10s elapses without ever seeing
  `in_progress`, give up — flip to `Call` and surface a soft error.
- **In `Hangup`:** flip to `Call` immediately on the first `ended`. The
  call has terminated (either via /dialpad-hangup or via Dialpad webhook).

Don't apply the 10s rule in `Hangup` — once we've confirmed the call was
live, an `ended` response is authoritative.

**Status codes:**

- `200` — happy paths above. Always JSON `{ state: ... }`.
- `400` — body missing `consultantFirstName`.
- `401` — missing/invalid `X-Extension-Token`.
- `403` — consultant name not in registry (typo, etc.).
- `502` — middleware → Dialpad call failed during discovery. **Treat as
  transient — keep polling.** Next 500ms tick is the natural retry.
- `500` — internal error. Same as 502 — keep polling.

### `POST /dialpad-call` (response shape unchanged from cleanup)

Request body, validation, rate-limit, and dedup behaviour are unchanged.
You should already be sending:

```json
{
  "consultantFirstName": "Joel",
  "phoneNumber": "+447700900123",
  "callerAliasId": "<JWT from /dialpad-user-context>"
}
```

**Response is `{ ok: true }` only — no `callId` field.** This was true in
the SSE design too; just confirming. If your code currently reads
`response.callId`, delete that read.

What changes server-side (you don't see this directly, but matters for
behaviour): the moment Dialpad accepts the call, the worker writes a
fresh KV record for the user, **overwriting any prior call's record**.
This means the polling loop should always reflect the most recent call
the user kicked off; you don't need to worry about stale state from a
previous attempt.

Failure shapes (`400`/`401`/`403`/`429`/`502`) are unchanged. On any
non-2xx, revert to `Call` and surface the error.

### `POST /dialpad-hangup` (request unchanged; one new soft-error case)

```http
POST /dialpad-hangup HTTP/1.1
Content-Type: application/json
X-Extension-Token: <per-user secret>

{ "consultantFirstName": "Joel" }
```

**Response:** `{ ok: true }` on 200, `{ ok: false, error: "..." }` otherwise.

Status codes:

- **200** — call terminated (or was already terminated by the Dialpad
  webhook arriving milliseconds earlier — either way the worker is back to
  clean state). Stop polling, flip to `Call`.
- **400 / 401 / 403** — same as before.
- **409 No active call** — the worker has no `call_id` cached for this
  user. **In normal use this should never happen** because the `Calling…`
  buffer prevents the user from clicking Hangup before `call_id` is bound.
  If you ever see it, treat as a soft error: flip to `Call`, surface
  "couldn't hang up — try again". Don't block the UI on it.
- **502** — Dialpad rejected the hangup (call already terminated, unknown
  ID, etc.). The worker's KV is cleared regardless. Treat the same as 200
  for UX purposes — flip to `Call`.

### `POST /dialpad-sms` (unchanged)

No changes. Same body, same response, same lack of rate-limit. Listed
here only because you might wonder.

### `POST /dialpad-user-context` (unchanged)

No changes. Caller-ID alias machinery is the same.

### `GET /extension-call-stream` (REMOVED)

Returns 404. Delete every reference.

---

## The typical call lifecycle

1. **User clicks Call** → extension fires `POST /dialpad-call`.
   Button → `Calling…`, disabled. **Start a 10-second clock.**
2. **`/dialpad-call` returns 200** `{ ok: true }`. Start polling
   `POST /extension-call-status` every ~500ms.
3. **Polling:** first 1-3 responses likely return `{state:"ended"}` (KV
   exists but `call_id` not yet bound — middleware returns ended in this
   case too because there's no active *bound* call yet) **or**
   `{state:"in_progress"}` (if discovery completed quickly). You can't
   distinguish "discovery still in flight" from "call ended" at the wire
   level — which is fine, the 10-second clock handles it.

   > Implementation note: as currently spec'd, the worker returns
   > `{state:"in_progress"}` while discovery is in flight (so a partial
   > KV record without `callId` shows as in_progress). Treat both responses
   > the same — keep polling and watch the clock.
4. **First `{state:"in_progress"}` after a `Calling…` phase** → button →
   `Hangup`. Cancel the 10s clock. Continue polling.
5. **(Path A) User clicks Hangup** → extension fires `POST /dialpad-hangup`.
6. **`/dialpad-hangup` returns 200** → stop polling, button → `Call`.
7. **(Path B, alternative to 5-6) User hangs up via Dialpad app, or via
   the Dialpad receiving the call** → next poll returns `{state:"ended"}` →
   stop polling, button → `Call`.

### Common edge cases

- **Dialpad rejects `/dialpad-call`** (no autocallable device, rate-limit,
  bad number). Step 2 fails — non-2xx response. Revert to `Call` and
  surface the upstream error string. No polling started.
- **`/dialpad-call` 200 but `in_progress` never arrives.** 10s clock
  elapses. Stop polling, button → `Call`, surface "couldn't confirm the
  call started — try again". The call may or may not have actually placed;
  the user can check Dialpad to be sure. (Practical cause: Dialpad's
  call-list lag, Dialpad-side webhook misconfiguration, or a very fast
  reject that we missed.)
- **Polling 502** during discovery. Just keep polling. The next 500ms tick
  will retry. Don't surface to the user. Don't add backoff — 500ms is
  already polite.
- **Polling 401/403.** Genuine auth/registry problem; surface as a config
  error. Stop polling.
- **User navigates to another profile mid-call.** Per UX philosophy:
  whatever component is running the polling loop unmounts; polling stops;
  the new page starts fresh with a `Call` button. The middleware's KV will
  expire after 20 minutes, or the user can hang up via Dialpad. We don't
  rehydrate state on the new page.
- **User clicks Call rapidly twice.** First click hits the worker's
  rate-limit (429 with `retryAfterSec`) or the dedup window (also 429).
  Use the existing 429 handling — show the retry-after message, leave the
  button in whatever state it was in.

---

## Polling implementation notes

### Cadence

500ms is the recommended cadence. Don't poll faster than 250ms (no benefit
and you'll burn middleware quota). Don't poll slower than 1s during a live
call (UX feels sluggish on hangup detection).

### Where the loop lives

Inside the component (or hook) that renders the button. `useEffect` →
`setInterval` → cleanup on unmount. **No service worker, no
`chrome.storage`, no `BroadcastChannel`.** When the component unmounts,
`clearInterval`, drop any in-flight `fetch`, done.

### Don't poll when there's nothing to poll for

The polling loop only runs while the button is `Calling…` or `Hangup`.
When the button is `Call`, no polling. Don't poll on a timer "just in case"
state changed — it can't, because `Call` means we haven't initiated
anything.

### Stop conditions (any of these → `clearInterval`)

- Polling returns `{state:"ended"}` while button is `Hangup` → flip to
  `Call`, stop.
- 10s clock elapses while button is `Calling…` without ever hitting
  `in_progress` → flip to `Call`, stop.
- `/dialpad-hangup` returns 200/502/409 → flip to `Call`, stop.
- Component unmounts (user navigated, popover closed, etc.) → stop.

### Don't echo the call to the user

The polling response intentionally doesn't include the phone number being
called. You already know what number was dialled — use that locally if you
want a "Hangup +44…" label. Don't try to read it from the response.

### CORS

The worker returns the standard CORS headers and accepts `OPTIONS`
preflight on this route, same as every other extension route. You should
not need any extra CORS config.

---

## Quick checklist of extension-side work

- [ ] Delete the `EventSource(/extension-call-stream)` consumer entirely.
      Delete `idle`/`active` state-machine code that was driven by it.
- [ ] Replace with a `setInterval`-driven `fetch` loop against
      `POST /extension-call-status` every ~500ms.
- [ ] Track only three button states locally: `Call`, `Calling…`,
      `Hangup`.
- [ ] On `/dialpad-call` 200: button → `Calling…`, start polling, start
      10s clock.
- [ ] First `{state:"in_progress"}` response: button → `Hangup`, cancel
      clock.
- [ ] `{state:"ended"}` while in `Hangup`: button → `Call`, stop polling.
- [ ] 10s clock elapses without `in_progress`: button → `Call`, stop
      polling, surface soft error.
- [ ] Hangup click: `POST /dialpad-hangup`, on any response (200/409/502)
      → `Call`, stop polling.
- [ ] Drop any read of `callId` from `/dialpad-call`'s response.
- [ ] Treat `{state:"ended"}` while in `Calling…` as "keep polling" (not
      "give up") — only the 10s clock decides give-up.
- [ ] Treat `502` from `/extension-call-status` as transient — keep
      polling.
- [ ] On component unmount, `clearInterval` and drop any in-flight
      fetches.

---

## Status of the middleware side

As of this hand-off date (2026-05-05), the middleware has done the
DO/SSE/webhook teardown but has **not yet shipped** the new
`/extension-call-status` route, the hangup webhook handler, or the new KV
record shape. `/dialpad-call` and `/dialpad-hangup` are running on the
intermediate cleanup-phase shape.

Coordinate ship timing with Joel before the extension goes live —
otherwise polling will hit 404 and Hangup will hit 409 in unexpected
windows. Suggested order: middleware ships first behind no flag, then
extension switches over.

---

## Operational notes

- **Logging.** The middleware logs every poll's discovery transition
  (`call_id` first bound), every webhook receipt with match/no-match
  reason, and every `/dialpad-hangup`. You don't need to send any extra
  observability data.
- **Rate.** A 90-second call at 500ms cadence = ~180 polling requests per
  call. Of those, 1-3 hit Dialpad's call-list during discovery; the rest
  are pure KV reads and very cheap. No middleware capacity concerns.
- **What if I want to ship the polling earlier than the middleware?**
  Don't. You'll get 404 on every poll. Either ship together, or
  feature-flag the polling behind a config the extension reads at startup.

That's it. Strip the SSE consumer, swap in the polling loop, keep the
button state machine three-valued, and you're done.
