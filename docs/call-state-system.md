# Call-State System — Current State + Known Issues

**Status as of 2026-05-01:** functionally working on the happy path. Known to be flaky under back-to-back calls, retried webhooks, and out-of-order Dialpad events. Stable enough to use; not stable enough to ship to additional users without addressing the reliability gaps below.

## Why this exists

Live call-state push to the LinkedIn extension's sidepanel, so the Call button flips to Hangup the moment a call connects and back to Call when it ends. Drives the Hangup endpoint that lets the user terminate via the extension instead of the Dialpad app.

## Where state lives

- **Per-user Durable Object (`EXT_CALL_CHANNEL`).** Keyed by `dialpadUserId` via `getByName(...)`. Each consultant has at most one DO instance globally, so all worker routes that touch their state hit the same instance — strongly consistent.
- **DO storage** holds two values:
  - `watch` → `{ phone, initiatedAt }` — set by `/dialpad-call` before invoking Dialpad's `initiate_call`. The expected destination of the call we just placed.
  - `active` → `{ callId, phone, startedAt }` — set when Dialpad's `calling` webhook arrives and matches `watch.phone`. Holds the live call_id (extension never sees it).
- **DO in-memory** holds the SSE writer set — every browser tab subscribed to `/extension-call-stream` registers a writer.

KV is **not** used for any call-state value. We tried; KV's eventual consistency (~60s cross-DC) returned stale nulls when reads landed at a different datacenter from writes. Migrated to DO storage in commit `7e74319`.

## End-to-end happy path

```
1. Extension mounts sidepanel
   → GET /extension-call-stream?consultantFirstName=Joel
   → DO.fetch() registers writer, replays initial state from storage
   → SSE: event:hello + event:state {state:"idle"}

2. User clicks Call
   → POST /dialpad-call { consultantFirstName, phoneNumber, callerAliasId }
   → Worker: rate-limit gate, alias verify
   → DO.clearAll() (one-in-one-out)
   → DO.setWatch({ phone, initiatedAt })
   → Dialpad initiate_call → 200
   → Worker returns { ok: true }

3. Dialpad fires `calling` webhook
   → POST /webhook/dialpad/extension-calls
   → JWT verify
   → processExtensionCallEvent:
     - DO.getWatch() → matches phone
     - DO.setActive({ callId, phone, startedAt })
     - DO.clearWatch()
     - DO.pushState({ state: 'active', phoneNumber })
   → SSE: event:state {state:"active",phoneNumber}
   → Extension flips button to Hangup

4. (Call happens)

5a. User clicks Hangup (extension button)
    → POST /dialpad-hangup { consultantFirstName }
    → DO.getActive() → returns { callId, phone }
    → Dialpad PUT /call/{callId}/actions/hangup → 200
    → DO.pushState({ state: 'ended', phoneNumber })
    → DO.clearAll()
    → Worker returns { ok: true }
    → Dialpad's own hangup webhook arrives ~2s later, finds no active,
      no-ops (avoids double push)

5b. User hangs up via Dialpad app instead
    → No /dialpad-hangup hit
    → Dialpad fires `hangup` webhook
    → processExtensionCallEvent:
      - DO.getActive() → call_id matches
      - DO.clearActive()
      - DO.pushState({ state: 'ended', phoneNumber })
    → SSE: event:state {state:"ended"}
    → Extension flips button back to Call
```

## What works

- ✅ `/extension-call-stream` SSE — subscribe, hello, initial state replay, heartbeat (alarm, every 25s).
- ✅ `/dialpad-call` writes the watch via DO RPC; the calling webhook reliably matches when it arrives within a few seconds.
- ✅ `/dialpad-hangup` reads call_id from DO storage (the KV-eventual-consistency bug that this fix targeted is gone).
- ✅ State machine pushes `state: active` on calling-webhook match and `state: ended` on hangup-webhook match.
- ✅ Extension's `EventSource` consumer connects, parses events, drives a local store. Multi-tab fan-out works (DO has multiple writers in the set).
- ✅ Defensive error handling around the SSE writer abort (commit `1b2cd09` killed the unhandled-rejection that was poisoning DO RPC after stream close).

## What's flaky

User-observed inconsistency under realistic conditions. None catastrophic, but enough to warrant attention before a wider rollout.

### 1. "No watch entry for user" on the calling webhook

Symptom: Dialpad's calling webhook arrives, the handler logs `→ ignored: no watch entry for user`, the SSE never gets `state: active`, the button stays on "Calling…" indefinitely (or whatever local fallback).

Suspected causes:
- **Back-to-back calls.** User dials A, dials B before Dialpad's calling event for A arrives. `/dialpad-call` for B does `clearAll()` which wipes A's watch. A's calling webhook then matches no watch.
- **Watch wiped by the matching transition itself.** Currently `processExtensionCallEvent` does `setActive(...)` then `clearWatch()`. If the calling webhook fires twice (Dialpad retry, network blip), the second pass finds an empty watch and ignores. Mostly harmless because the first pass already pushed state, but worth confirming.

### 2. "No active call for user" on the hangup webhook

Symptom: hangup webhook arrives, handler logs `→ ignored: no active call for user`, no SSE push.

Already partially expected after commit `8dd4a52` — when the *user* clicks the extension's Hangup, we push `state: ended` and clear active in `/dialpad-hangup` itself. The hangup webhook then arriving 2s later correctly no-ops.

But sometimes this no-ops in the "hung up via Dialpad app" path too, where it shouldn't. Suspected cause: the user already cleared state by placing a *new* call between the original hangup happening and Dialpad's hangup webhook arriving. The new `/dialpad-call`'s `clearAll()` wiped active before the hangup webhook could match.

### 3. Out-of-order Dialpad events

Per Dialpad's own docs: *"Events may be received out of order."* If `hangup` lands before `calling`:
- hangup → no active → ignored
- calling → watch matches → active set, push state=active
- Now active is set with no corresponding hangup forthcoming for that ID. Stuck on Hangup until the user makes another call.

We don't currently sort by `event_timestamp` before processing. Adding that wouldn't fully fix it (events may genuinely arrive long after one another), but would handle the common short-window case.

### 4. Webhook retries

Dialpad retries failed deliveries. If our worker briefly errored on a webhook, the retry could arrive seconds-to-minutes later. By then state has moved on (next call started, etc.) and the retry's match is wrong or stale.

### 5. SSE reconnect coupled with state transitions

Extension's `EventSource` auto-reconnects on transport drop. The DO replays current state on reconnect via `_readCurrentState()`. If a state transition (e.g., webhook setting active) happens *between* the disconnect and the reconnect's storage read, the reconnect could either:
- See the new state (good)
- See stale-cached `_activeCache` from the previous DO instance (in-memory, not from storage)

The in-memory cache is reset when the DO is evicted (constructor runs), but if the DO stays alive across the SSE drop, the cache persists. Worth verifying behavior here is correct.

## Suspected root themes

Underlying all of the above: **the state machine assumes Dialpad webhooks arrive promptly, in order, and exactly once.** None of those are guaranteed. The current architecture is event-driven over an unreliable transport without any reordering, deduplication beyond the immediate state, or compensation for retries.

This is what the user already flagged: *"managing state is absolutely not what KV should be used for"* — and even with the KV→DO move, the underlying fragility is event-ordering-related, not just storage-consistency.

## Quick wins (if we pick this up next)

In rough order of effort vs payoff:

1. **Track every active callId we've seen recently in DO storage** (rolling window, ~5min). On any inbound webhook event, if `call_id` is "known terminated", drop it. Kills the retry-arriving-late and out-of-order-hangup-then-calling cases.
2. **Sort multi-event payloads by `event_timestamp`** before processing. Dialpad sometimes batch-delivers; ordering them locally is cheap.
3. **Don't `clearAll()` on every `/dialpad-call`** — instead, only clear `active` if the previous active.callId is "stale" (older than e.g. 60s and no recent state push). Less destructive to in-flight state machines.
4. **Add a TTL alarm** on `active` (e.g., 30 min). If the hangup webhook never arrives, the state self-heals after the alarm fires.
5. **Log every webhook arrival with payload hash + state transition decision**, so we can debug specific incidents from the trace alone.

## Longer-term

User has flagged a deeper rearchitecture: queue-backed event processing with a message bus, ordered consumption, idempotent handlers. That's a different scale of project — months not days. The DO migration we just did is a stepping stone toward it (DOs are a reasonable home for the per-user actor model that a queue+bus design would converge to). Out of scope for this writeup.

## Alternative architecture: per-user Dialpad WebSocket subscriptions

The cleanest answer to the entire class of issues above is to **stop using webhooks for call-state and use Dialpad's WebSocket subscriptions instead**, scoped to the individual user and to the specific call we just placed.

### The core insight

Webhooks are a *broadcast firehose* — every state event for every user in the company hits one URL. We then have to:
- Filter by `target.id` to figure out which user it's for
- Filter by `direction` to ignore inbound calls
- Match `external_number` against a watch entry to figure out which extension click triggered it
- Dedupe retries and out-of-order deliveries

All of that complexity exists because we're trying to recover the call-context that was discarded when Dialpad fanned the event out to a global webhook.

WebSocket subscriptions can be **created and destroyed programmatically, scoped to a single user, scoped to specific call states**. So we never have to recover context — we just don't lose it in the first place.

### How it would work

Per-user setup (once, at hire time — automatable when adding to the team registry):
- Worker creates a Dialpad WebSocket subscription scoped to that user_id, subscribed to no events initially.

Per-call flow:
1. User clicks Call. Extension hits `/dialpad-call` as today.
2. Worker resolves the consultant's WebSocket connection (or opens it if not already alive — likely held in a per-user Durable Object similar to today).
3. Worker **subscribes the socket to `calling` and `hangup` events** for this user.
4. Worker pauses (microsecond-scale) and sends the Dialpad `initiate_call` API request.
5. The very next event arriving on this socket *is* our call. No filtering needed — we know it's outbound (because we just initiated it), we know the user (the socket is theirs), and the timing window is so tight that any other event would be statistically improbable. Grab the `call_id` from this event.
6. Stream `state: active` to the extension. Listen on the socket for the matching `hangup` event.
7. On hangup: stream `state: ended`, unsubscribe the socket from `calling`/`hangup`, idle.

### Why this is structurally better

- **No multi-tenant routing.** The socket only carries one user's events.
- **No webhook firehose to parse.** We're not filtering through hundreds of events to find ours; we're literally consuming one targeted stream.
- **No phone-number-match heuristic.** We don't need to remember "the user just dialled +44...". The socket *is* the heuristic — anything appearing during our subscription window is ours.
- **No dedup needed for the common case.** Sockets don't retry the way webhook delivery does. Out-of-order is also less likely (a single TCP-ordered stream).
- **Lower latency.** Sockets are persistent, no per-event HTTPS handshake overhead. Events show up faster after Dialpad emits them.
- **Cleanly composable.** Add a new state type (e.g., `connected`, `recording`) by subscribing to it. Drop one by unsubscribing. No deploy-time webhook config dance.

### What it would cost / replace

- The `/webhook/dialpad/extension-calls` HTTP endpoint goes away entirely.
- The state-machine logic in `extension-calls.js` simplifies to "what came on the socket during my subscription window?" — way less code.
- The per-user Durable Object becomes the natural home for the WebSocket connection (DOs already support hibernating WebSockets, so an idle socket costs ~0).
- One-time programmatic setup of per-user Dialpad subscriptions; tear-down on user removal from registry.

### Why we're not doing it now

It's a meaningful rebuild of the entire call-state surface, not a patch. We've already got DO + KV + webhook plumbing in place that *mostly* works, and the user's primary use case (single-recruiter testing) tolerates the current flakiness. Worth circling back to once the team grows or the flakiness starts costing real recruiter time.

### Trigger to revisit

- Adding a third recruiter (Joel + Alice + N) — webhook-firehose filtering cost is per-recruiter and hits us O(team_size × call_volume).
- A real production incident where the wrong call's state leaks to the wrong user's button (collision on phone-match heuristic).
- Wanting `connected` / `recording` / other lifecycle states on the extension (would be near-trivial with sockets, additive but messy with webhooks).

## Files to remember

- `src/extension-call-do.js` — DO class. Holds writers, watch+active in DO storage, RPC methods (`getWatch`, `setActive`, `clearAll`, `pushState`), heartbeat alarm.
- `src/extension-calls.js` — webhook state machine. `processExtensionCallEvent` is the entry point.
- `src/index.js`
  - `/dialpad-call` handler: writes watch via DO before Dialpad call.
  - `/dialpad-hangup` handler: reads active via DO, calls Dialpad, pushes ended, clears.
  - `/extension-call-stream` GET: forwards to DO via `stub.fetch()`.
  - `/webhook/dialpad/extension-calls` POST: JWT verifies, calls `processExtensionCallEvent`.
- `wrangler.jsonc` — `EXT_CALL_CHANNEL` binding + `v1` migration with `new_sqlite_classes: ["ExtensionCallStateChannel"]`.

## Recent commits in this thread (reverse chrono)

- `8dd4a52` — push state=ended from /dialpad-hangup before clearing
- `7e74319` — KV → DO storage for call-state (the big consistency fix)
- `1b2cd09` — defensive error handling in DO; surface real pushState errors via `.catch()` on writer.close
- `5985f14` — SSE deadlock fix: defer initial writes after Response returns
- `30efe15` — initial DO + SSE wiring + handoff doc
- `6a0a1d9` — `/dialpad-sms` endpoint + sendSMS Dialpad client (pre-thread)

## Where to start when picking back up

Run `wrangler tail` in pretty mode, place a few back-to-back test calls, and watch for `→ ignored:` log lines on the webhook handler. The reasons there (e.g., `no watch entry for user`, `phone mismatch`, `no active call for user`, `call_id mismatch`) tell you exactly which class of flakiness fired. Tackle (1) from "Quick wins" first — the recently-terminated-call-id memory — that's likely to absorb most of the observed inconsistency.
