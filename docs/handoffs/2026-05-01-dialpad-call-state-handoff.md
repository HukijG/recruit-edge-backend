# Dialpad Call State + Hangup — Middleware → Extension Hand-off Spec

**Date:** 2026-05-01
**Direction:** middleware → extension (this is what the extension side
builds against)
**Companion to:** `2026-05-01-dialpad-middleware-handoff.md` and
`2026-05-01-dialpad-sms-middleware-handoff.md` — same conventions apply
(`X-Extension-Token` auth, `consultantFirstName` server-side lookup,
`{ ok, error }` response envelope, `MIDDLEWARE_URL` env var).

## What you're being asked to build

Three things, all on top of the existing calling/SMS flows you already
shipped (background message handlers `initiateDialpadCall`,
`sendDialpadSms`, etc):

1. **Live call-state subscription** via Server-Sent Events. The middleware
   pushes state transitions (`idle → calling → active → ended`) and the
   button in the popover toggles between **Call** and **Hangup** based on
   them. Always-on stream, opened once per sidepanel mount, kept alive for
   the session.
2. **`/dialpad-hangup` integration** — new endpoint, called when the user
   clicks the Hangup button. The extension does **not** know the Dialpad
   `call_id` — the worker holds it. You send only `consultantFirstName`.
3. **One small change to the existing `/dialpad-call` response** — `callId`
   is no longer returned. If you currently stash it, drop the field.
   Nothing else about `/dialpad-call` changes.

Everything else (caller-ID picker via `/dialpad-user-context`, sending SMS
via `/dialpad-sms`, the dev test-call view) is unchanged.

## The state machine

The button has four logical states. The extension drives transitions based
on a mix of `/dialpad-call` request lifecycle and SSE events:

| State | Button label | How you enter |
|---|---|---|
| `idle` | **Call** (enabled) | Initial state. Also entered on `state: ended`, on `state: idle`, on call failure, or after the user clicks Hangup successfully. |
| `calling` | **Calling…** (disabled) | Entered locally the moment the extension fires `/dialpad-call`. Also entered if the SSE replay says `state: calling` (a tab opened mid-dial before the Dialpad `calling` event landed). |
| `active` | **Hangup** (enabled, red) | Entered when SSE delivers `state: active`. Worker pushes this once Dialpad confirms the call is being placed (Dialpad `calling` event matched the watch KV). |
| `ended` | **Call** (enabled) | Entered when SSE delivers `state: ended`. Worker pushes this when the Dialpad `hangup` event fires for the active call — covers both extension-initiated hangups and "user hung up via the Dialpad app" cases. |

**The SSE stream is the source of truth** for any transition the worker
controls. The extension transitions to `calling` locally on its own
intention (button click → request in flight) but never invents `active` or
`ended` without an SSE event.

### Edge: the calling-event timeout

If `/dialpad-call` returns 200 but no `state: active` arrives within ~15
seconds, treat the call as failed and revert to `idle`. The middleware's
watch KV expires after 90s, so any later `calling` event would be a no-op
anyway. (Common cause: Dialpad rejected after returning 200, or webhook
delivery hiccup.) The middleware will not produce a misleading later
event in this case — once the watch expires, the slot is dead.

### Edge: the user clicks Hangup before SSE delivers `active`

Don't enable the Hangup button until you receive `state: active`. While in
`calling` state the button is disabled. If you absolutely want a "cancel
during dial" affordance, it's a separate UX (call `/dialpad-hangup`
anyway and accept that you might get 409 `No active call` because the
worker hasn't seen the calling event yet — surface that as an inline
"Couldn't cancel — call may not have started yet, try again in a second"
message).

## New: `GET /extension-call-stream` (Server-Sent Events)

Long-lived SSE stream the extension keeps open while the consultant is
using the sidepanel. State pushes flow over this.

### Request

```http
GET /extension-call-stream?consultantFirstName=Joel HTTP/1.1
Host: <MIDDLEWARE_URL host>
Accept: text/event-stream
```

- `consultantFirstName` (query param, required) — same server-side
  lookup every other extension route uses (resolves to a Dialpad user
  ID). Not in the body because SSE is GET-only.

### Auth

**Currently unauthenticated.** Use `EventSource` directly. We're rolling
out a proper OTP + session-token auth flow across all extension routes
shortly; until then, this stream is open. Don't put the existing
`X-Extension-Token` shared secret in the URL — it'd just leak to CF
Logs, and the secret is bundled into the extension anyway so it's not a
real boundary. When the session-token flow lands, this route will start
verifying it (almost certainly via a query param the extension already
holds from sign-in — coordinate with the auth ticket then).

### Consumer pattern — use `EventSource`

```ts
const url = new URL(`${MIDDLEWARE_URL}/extension-call-stream`);
url.searchParams.set("consultantFirstName", name);

const es = new EventSource(url.toString());

es.addEventListener("hello", () => {
  // stream is live; nothing to do
});

es.addEventListener("state", (event) => {
  const { state, phoneNumber } = JSON.parse(event.data);
  // state ∈ {"idle","calling","active","ended"}
  callStore.setState(state, phoneNumber);
});

es.onerror = () => {
  // EventSource auto-reconnects with backoff. The DO replays current
  // state from KV on reconnect, so you don't need to do anything here
  // beyond optionally surfacing a "reconnecting" UX.
};

// Cleanup on sidepanel/extension teardown:
es.close();
```

`EventSource` handles reconnect natively (with backoff and the
`Last-Event-ID` mechanism — we don't emit IDs, but the reconnect itself
is free). The DO's initial-state replay (see below) means a reconnect
silently restores correct UI without any polling.

#### Where to put the consumer

Put it in the **sidepanel** or wherever your candidate UI lives — that
context's lifecycle naturally matches when you want the stream open.
Don't put it in the **MV3 background service worker** — `EventSource`
support there varies across Chrome versions and the service worker can
get killed mid-stream. If you need cross-tab sharing, broadcast events
from the sidepanel into a `BroadcastChannel` other contexts subscribe
to (or just rely on the DO fan-out — every tab that opens its own
sidepanel automatically subscribes to the same DO instance and gets
the same events).

#### `: keepalive` comment lines

The DO sends an SSE comment line every ~25s to keep proxies from
killing the connection. `EventSource` silently swallows comments — you
won't see them in any listener. Just so you know they exist.

### Response

`Content-Type: text/event-stream`. CORS headers are included. Three event
types:

**`event: hello`** — fired once, immediately on connect.
```
event: hello
data: {"ok":true}
```
Use this as confirmation the stream is live. Nothing else to do.

**`event: state`** — fired on every state transition AND once on connect
(initial replay from KV, so a tab opening mid-call gets the right button
without waiting for a transition).
```
event: state
data: {"state":"idle","phoneNumber":null}
```
or
```
event: state
data: {"state":"calling","phoneNumber":"+447700900123"}
```
or
```
event: state
data: {"state":"active","phoneNumber":"+447700900123"}
```
or
```
event: state
data: {"state":"ended","phoneNumber":"+447700900123"}
```

`phoneNumber` is the candidate's number (E.164), useful for sanity-
checking the active state matches what the user dialed and for showing
"Hangup +44…" if you want. Won't be present in the `idle` payload.

**`: keepalive`** — sent every ~25s by a Durable Object alarm. These are
SSE comment lines (start with `:`, no event name, no data). `EventSource`
silently swallows them — listed here only so you know they're present
in the wire format if you're ever inspecting the raw stream.

### Reconnect

`EventSource` handles reconnects natively — on transport failure (network
change, sleep/wake, occasional Worker eviction of the Durable Object) it
auto-reconnects with browser-managed backoff. You only need to:

- Listen for `es.onerror` if you want to surface a "reconnecting…"
  affordance.
- **Don't manually close + reopen on every error.** Let the browser do
  it.

On every reconnect, the DO replays the current state from KV (active /
calling / idle). So **you never need to poll on reconnect** — the SSE
stream itself is self-healing for state.

Once auth lands and a session-token expires mid-stream, the worker will
respond with a non-2xx that disables `EventSource`'s auto-reconnect; you
catch that in `onerror` and surface a sign-in prompt. Not a concern
today (no auth on this stream yet).

### Lifecycle

- Open the stream when the sidepanel mounts (or when candidate-mode first
  activates per session — your call). Open it once per consultant; the
  middleware fans the same DO instance to every tab.
- Close it (`es.close()`) when the sidepanel unmounts, the consultant
  signs out, or the extension is uninstalled.
- Multiple tabs are fine. The DO holds one writer per open stream and
  pushes every state event to all of them.

## New: `POST /dialpad-hangup`

Called when the user clicks the **Hangup** button (only enabled in the
`active` state).

### Request

```http
POST /dialpad-hangup HTTP/1.1
Host: <MIDDLEWARE_URL host>
Content-Type: application/json
X-Extension-Token: <per-user secret>

{
  "consultantFirstName": "Joel"
}
```

That's the entire body. **No `callId`, no `phoneNumber`** — the worker
already holds the active `call_id` in KV (written when the matching
Dialpad `calling` event landed) and reads it server-side.

### Response

**Success (200):**
```json
{ "ok": true }
```
The extension can transition to `idle` immediately on 200 — but the
authoritative confirmation also flows through SSE as `state: ended`
(when the matching Dialpad `hangup` event fires). Either is fine to drive
UI; using both is redundant but safe.

**Failure:**

```json
{ "ok": false, "error": "<short human message>" }
```

Common cases:
- **400** `"Missing \"consultantFirstName\""`
- **401** `"Authentication failed"` — bad `X-Extension-Token`
- **403** `"Consultant not found"` — name doesn't map
- **409** `"No active call"` — the worker has no active call recorded
  for this consultant. Most common reason: the Dialpad `calling` event
  hasn't landed yet (you're hanging up before the `active` state
  arrived). Surface as something like *"No active call to hang up"* and
  re-enable whatever button got disabled.
- **502** `"Dialpad rejected the hangup: <upstream message>"` — the call
  may already have terminated, or Dialpad couldn't find it. Either way,
  the extension's KV state is reset on 502 too — treat as `idle`.

### Idempotency note

Every `/dialpad-hangup` clears the worker's active-call KV regardless of
whether Dialpad accepted the hangup. Spamming the button is safe — the
state machine just resets. No double-hangup risk.

## Changed: `POST /dialpad-call` response

The request body and validation rules are exactly the same as before
(see `2026-05-01-dialpad-middleware-handoff.md` for the contract).

**Only change:** the success response no longer includes `callId`.

Old:
```json
{ "ok": true, "callId": "5747322335264768" }
```

New:
```json
{ "ok": true }
```

If your background handler reads `callId` from the response, drop that
read — the worker holds the call_id end-to-end now and the extension
must not need it for any flow (hangup is by `consultantFirstName`).

Failure shapes (400/401/403/429/502) are unchanged.

## Putting it together — the typical call lifecycle

1. **Sidepanel mounts** → extension opens
   `GET /extension-call-stream?consultantFirstName=Joel`. SSE delivers
   `event: hello` then `event: state\ndata: {state:"idle"}`. Button = **Call**.
2. **User clicks Call** → extension fires `POST /dialpad-call`.
   Local state goes to `calling`. Button = **Calling…**, disabled.
3. **`/dialpad-call` returns 200** `{ ok: true }`. Local state stays
   `calling` until SSE confirms.
4. **Dialpad fires its `calling` event to the worker**. Worker matches
   the watch entry, writes the active-call KV, pushes
   `event: state\ndata: {state:"active",phoneNumber:"+44..."}` to your
   SSE stream.
5. **Extension receives `state: active`** → button = **Hangup**, enabled.
6. **User clicks Hangup** → extension fires
   `POST /dialpad-hangup` with `{ consultantFirstName: "Joel" }`.
7. **`/dialpad-hangup` returns 200** → you can transition to `idle` now.
   The worker also clears its active-call KV.
8. **Dialpad fires its `hangup` event to the worker**. Worker pushes
   `event: state\ndata: {state:"ended",phoneNumber:"+44..."}` over SSE.
   Extension can ignore (already idle) or use as a redundant confirm.

### Alternative: hung up via Dialpad app

Same flow, but step 6 happens in the Dialpad desktop/web app instead.
Step 7 is skipped (the extension never sent a hangup request). Step 8
still fires — and that's how the extension learns the call ended. The
SSE event flips the button back to **Call** automatically.

### Alternative: Dialpad rejects `/dialpad-call`

Step 3 returns 502 instead of 200. Local state goes back to `idle`. The
worker also cleans up its watch KV (no `calling` event would fire
anyway). No SSE traffic involved. Surface the upstream error string as
inline feedback.

### Alternative: Dialpad never fires the `calling` event

Step 4 doesn't happen (network glitch, Dialpad bug, whatever). Watch KV
expires after 90s server-side. On the extension, your 15s timeout in
`calling` state fires first — revert to `idle`, surface a soft "couldn't
confirm the call started" message.

## Multi-tab / multi-window behaviour

The Durable Object is keyed by `dialpadUserId` (server-side, derived
from `consultantFirstName`). Every tab the consultant has the sidepanel
open in subscribes to the same DO. State events fan to all of them.

This means: if the consultant clicks Call in tab A, then opens tab B
during the call, tab B's button correctly shows **Hangup** the moment
the SSE stream connects (initial state replay). When the call ends,
both tabs flip back to **Call**.

You don't need any per-tab coordination logic — the SSE channel
provides it.

## Operational notes

- **One stream per consultant per session is enough.** Don't open one
  per candidate or per popover mount — keep a single long-lived stream
  in the background script (or wherever your persistent extension state
  lives) and have UI components subscribe to a local store driven by
  it.
- **Don't store the `call_id` anywhere.** It's not on any extension
  surface anymore. If a previous version of the extension code stashed
  it from `/dialpad-call`, remove the storage write.
- **Ignore unknown `event:` types.** The middleware may add events
  later (e.g. `event: notice` for soft warnings). Forward-compatible
  parsers should default to ignoring unknown event names.
- **CORS.** The worker advertises `X-Extension-Token` in
  `Access-Control-Allow-Headers` and supports `OPTIONS` preflight on
  every route, so cross-origin GET works the same as the existing POST
  routes.
- **Logging.** The state machine and DO push are logged server-side.
  You don't need to send any extra observability data; the worker logs
  every transition with `dialpadUserId` for cross-referencing.

## Quick checklist of extension-side work

- [ ] Open `new EventSource(url)` against
      `GET /extension-call-stream?consultantFirstName=…` from the
      sidepanel (or wherever the call UI lives) on first mount.
- [ ] Subscribe to the `hello` and `state` events;
      `JSON.parse(event.data)` gives `{ state, phoneNumber }`.
- [ ] Maintain a local store with one of `{idle, calling, active,
      ended}` driven by `state` events plus the
      `/dialpad-call`/`/dialpad-hangup` request lifecycle.
- [ ] Wire the popover Call button to dispatch `/dialpad-call` and
      transition to `calling` locally.
- [ ] Wire the same button (label flipped to Hangup) to dispatch
      `/dialpad-hangup` when state is `active`.
- [ ] Add a 15s timeout in `calling` state → revert to `idle` and show
      a soft "couldn't confirm" message.
- [ ] Drop any read of `callId` from `/dialpad-call`'s success
      response.
- [ ] Handle 409 from `/dialpad-hangup` as a soft error (not a crash).
- [ ] Call `es.close()` on sidepanel/extension teardown.

That's it. Once the consumer is wired and the button is bound to the
local store, the rest is automatic — every state event is the worker
telling you exactly what the UI should show.
