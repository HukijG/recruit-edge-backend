# Music worker (`rf-music-remote`)

Live doc for the **music remote** sphere — a brand-new, isolated Cloudflare Worker
subtree at `music-worker/`. It mirrors `cache-worker/` + `mcp-remote/` as an
independent install root (own `package.json` + committed `package-lock.json`, own
`wrangler.music.jsonc` with `"name": "rf-music-remote"`, own `src/` / `test/` /
`vitest.config.js`). It is **not** part of `rf-dialpad-sync-dev` and touches no
existing subtree.

It lets every recruiter's extension ([recruit-extension](https://github.com/HukijG/recruit-extension))
drive the music player on the office-TV kiosk
([recruit-tv-dashboard](https://github.com/HukijG/recruit-tv-dashboard)) — transport,
volume, search, play/enqueue, playlists — and streams the TV's now-playing snapshot
back to all of them over a WebSocket, so the whole team shares control of one
office TV.

## Deliberate non-features (waivers)

- **OTel observability is WAIVED.** No `@microlabs/otel-cf-workers`, no
  `@opentelemetry/*`, no `instrument()` wrapper, no `flow.name`, no `LD_OTLP_*`
  vars. Only Cloudflare's native Workers Logs stay on (the `observability.logs`
  block in `wrangler.music.jsonc`). The Durable Object opens the upstream
  WebSocket via **plain `fetch`** — no wrapper. The absence of OTel is the proof
  of the waiver; do not add it.
- **No service binding** to `rf-dialpad-sync-dev` or any sibling. The worker is
  standalone: it reaches the dashboard via plain outbound `fetch`
  (`DASHBOARD_REMOTE_BASE`). Auth is **JWT-only** — there is **no** D1 / `USERS_DB`
  binding and no team-registry read. It cannot affect the live worker.

## Two surfaces, separated by ownership

### Inbound — extension → music worker (`/music/*`), this worker's OWN API

Every route runs `authMusicRequest` first (see Auth). Request shapes are frozen in
`src/route-map.js` and here.

**Path (`QUEUED` vs `DIRECT`).** Five command routes are `QUEUED` — they route
**through the singleton DO's global command queue** (serialized + per-category
cooldown across ALL consumers) and return **`202 { ok:true, queued:true }`**
immediately; the truth returns over the now-playing WS. The remaining routes are
`DIRECT` — stateless proxies with no cooldown (transport pause/resume, volume, and
the idempotent reads). See **Global command queue + per-category cooldowns** below.

| Route | Method | Body / query | Path | Notes |
| --- | --- | --- | --- | --- |
| `/music/pause` | POST | `{}` | DIRECT | transport |
| `/music/resume` | POST | `{}` | DIRECT | transport |
| `/music/next` | POST | `{}` | **QUEUED** | category `skip` (shared with `prev`), cooldown 5000ms |
| `/music/prev` | POST | `{}` | **QUEUED** | category `skip` (shared with `next`), cooldown 5000ms |
| `/music/volume` | POST | `{ direction: "up" \| "down" }` | DIRECT | the worker forwards the bare `{ direction }` **verbatim**; the **dashboard** owns the fixed ±step magnitude (single source of truth) — never client-supplied, never computed by the worker |
| `/music/play` | POST | `{ id: <Deezer id> }` | **QUEUED** | category `play` (shared with `playlist-play`), cooldown 5000ms; id validated numeric → 400 otherwise, forwarded as a STRING (see Outbound) |
| `/music/enqueue` | POST | `{ id: <Deezer id> }` | **QUEUED** | category `enqueue`, cooldown 10000ms; id forwarded as a STRING |
| `/music/playlist-play` | POST | `{ id: <Deezer id> }` | **QUEUED** | category `play` (shared with `play`), cooldown 5000ms; id forwarded as a STRING |
| `/music/search` | GET | `?q=<free text>` | DIRECT | idempotent read |
| `/music/playlist-search` | GET | `?q=<free text>` | DIRECT | idempotent read |
| `/music/playlist-contents` | GET | `?id=<numeric Deezer id>` | DIRECT | id validated numeric |
| `/music/ws-ticket` | POST | — | DIRECT | auth-gated; issues a single-use WS ticket (see WS auth) |
| `/music/now-playing` | GET (Upgrade: websocket) | — | DIRECT | now-playing fan-out; the **DO redeems the subprotocol ticket** (no header auth that would leak into a URL/log) |
| `/health` | GET | — | — | unauthenticated liveness |

### Outbound — music worker → dashboard (`/api/remote/*`), FROZEN cross-repo contract

`src/proxy.js` does a **plain `fetch`** (no wrapper, no OTel) to
`${DASHBOARD_REMOTE_BASE}${path}` with the frozen outbound header
**`X-Remote-Key: ${DASHBOARD_REMOTE_KEY}`**. The dashboard response is streamed
back to the extension verbatim.

`src/route-map.js` maps each `/music/*` route to its dashboard sub-path. The 11
sub-paths are confirmed against the dashboard's actual `/api/remote/*` routes:

| `/music/*` route | dashboard sub-path |
| --- | --- |
| `pause` | `/api/remote/pause` |
| `resume` | `/api/remote/resume` |
| `next` | `/api/remote/next` |
| `prev` | `/api/remote/prev` |
| `volume` | `/api/remote/volume` |
| `search` | `/api/remote/songs/results` (forwards `?q=`) |
| `play` | `/api/remote/songs/play` |
| `enqueue` | `/api/remote/songs/enqueue` |
| `playlist-play` | `/api/remote/playlists/play` |
| `playlist-search` | `/api/remote/playlists/search` (forwards `?q=`) |
| `playlist-contents` | `/api/remote/playlists/contents` (forwards `?id=`) |

`throwIfUnset()` is retained as a safety net but, with every value real, never
fires. The frozen bits (X-Remote-Key, `DASHBOARD_REMOTE_BASE`, Deezer numeric ids)
are hard-coded. The volume ±step magnitude is **not** in this worker — the worker
forwards the bare `{ direction }` and the **dashboard** owns the magnitude.

**Deezer id is forwarded as the canonical digit-STRING (single source of truth).**
The dashboard's `play` / `enqueue` / `playlist-play` routes deserialize
`IdBody { id: String }`, so a JSON **number** is a `422 Unprocessable`. The id is
therefore forwarded as the string returned by **`parseDeezerId().idStr`** — the
validation gate **and** the forwarded value are the *same* parser computation, so
they cannot drift on a future edit. `idStr` is the caller's **exact trimmed
digit-string**, *not* a `String(Number(...))` round-trip (which is lossy:
`String(Number('007')) === '7'` drops leading zeros, and
`String(Number('9007199254740993')) === '9007199254740992'` truncates above
`MAX_SAFE_INTEGER`). **Caveat:** callers MUST send Deezer ids as JSON **strings**
(`{"id":"9007199254740993"}`) to preserve >2^53 precision — a *bare* JSON number
above 2^53 is already truncated by `JSON.parse` before the worker runs and cannot
be recovered. The `playlist-contents` GET still uses `?id=` from `parsed.id`
(unchanged — a wire query-param is a string and the dashboard reads a query param,
not a JSON `IdBody`, so no number/string mismatch exists there).

**Validation ordering.** The router validates the **inbound** request shape (this
worker's own contract: direction, numeric Deezer id, `q` present, well-formed JSON)
**before** resolving the outbound dashboard sub-path. A malformed client request
therefore returns a **400** describing the client's error — not the **501**
placeholder error, which is about the *unfrozen outbound wiring* and would mislead
the client into thinking the route is unimplemented when their input was invalid.
The two concerns are independent.

**Error responses are uniformly structured.** Every failure path returns
`json(status, { ok:false, code?, error })`: `401` auth, `400` validation, `404`
unknown route, `405` wrong method, `426` non-Upgrade WS, `501` unset dashboard path,
and **`502 { code:'dashboard_unreachable' }`** when the outbound
`fetch` to the dashboard rejects (DNS failure / cold or absent ingress — the
expected steady state while the dashboard is built in parallel). The extension's
error handling stays uniform regardless of dashboard availability. For a `QUEUED`
route the success response is **`202 { ok:true, queued:true }`** (the command was
enqueued, not yet delivered), and a DO overload / broken-input-gate / enqueue
exception surfaces as the same structured `502 { code:'dashboard_unreachable' }` —
the queued path is wrapped in the identical structured-502 discipline as the direct
path so a queue-unavailable failure never becomes an opaque runtime 500.

## Global command queue + per-category cooldowns

Multiple people now control the TV. Spamming `next`/`prev` (or rapid
`play`/`enqueue`) breaks dashboard delivery, so the five command routes are
**SERIALIZED + RATE-LIMITED GLOBALLY** (across ALL extension consumers) — **not
dropped**. The singleton Music DO (binding `MUSIC_REMOTE`, fixed name `global`) is
the only shared point across consumers, so the queue lives there. `index.js` routes
`next`/`prev`/`play`/`enqueue`/`playlist-play` to the DO via **`POST
/enqueue-command`** on the DO stub (mirroring how the `/ws-ticket` DO fetch path is
wired); the other routes stay direct proxies.

**Shape.** A FIFO array persisted at `ctx.storage` key `cmdQueue`; each element is
`{ category, dashboardPath, body, enqueuedAt, attempts }`. `body` is the exact
replay bytes (`'{}'` for `next`/`prev`, `'{"id":"<digits>"}'` for the id routes —
the canonical `idStr`, or `null`). Per-category last-execution timestamps live at
`lastExec:<category>`. Both the array and the timestamps are SQLite-backed via
`ctx.storage` so they **survive hibernation / eviction**. The DO is
**route-agnostic** — it only ever sees `{ category, dashboardPath, body }`; the
route→category map (`next`/`prev`→`skip`, `play`/`playlist-play`→`play`,
`enqueue`→`enqueue`) lives in `index.js`.

**Constants** (named, module-level, exported for tests): `COOLDOWN_MS = { skip:
5000, play: 5000, enqueue: 10000 }` (minimum spacing between EXECUTIONS, global),
`MAX_QUEUE = 100`, `MAX_DELIVERY_ATTEMPTS = 2`, `DELIVER_TIMEOUT_MS = 5000`.

**Arrival** (`enqueueCommand`). Read `cmdQueue` FRESH, append the element, **persist
before the next await**, `reconcileAlarm()` to arm the drain, and respond `202 {
ok:true, queued:true }` IMMEDIATELY (fire-and-forget — the real result returns over
the now-playing WS).

**Drain order — FIFO WITHIN a category, cross-category overtaking ACROSS them.**
The queue is **not** strict global FIFO. The per-category cooldown machinery exists
to **decouple** categories — a 10s `enqueue` cooldown must not stall a stone-cold
`skip`. So the drain selects the **first cooldown-ELIGIBLE** command
(`firstEligibleIndex` — the *drain-eligible head*, not strictly index 0): a
cooldown-blocked head is **overtaken** by the earliest-enqueued command of a
*different, idle* category behind it, rather than blocking it. **FIFO within a
category is preserved**: a front-to-back scan returns the earliest-enqueued eligible
command, and two commands sharing a category share **one** `lastExec:<cat>` timer —
so if an earlier same-category command is blocked, the later one is **equally**
blocked and can never overtake it. Only a *different* idle category overtakes a
blocked one. (Without this, one consumer's `enqueue` would couple everyone's
`skip`/`play` latency to the 10s enqueue cooldown — exactly the coupling the
per-category design exists to avoid; pinned by test (D2)/(D3).)

**Drain** (alarm-driven, `drainOneEligible` — SINGLE-SHOT, not a gate-holding
loop). Read `cmdQueue` FRESH; for the candidate command's category `last =
(lastExec:<cat>) ?? 0` — the **`?? 0` is load-bearing**: a first-ever /
post-eviction-empty `lastExec` is `undefined`, and `now >= undefined + cooldown` is
`now >= NaN` (false → a wedge) while `Math.max(NaN, now)` is `NaN` (an invalid
`setAlarm`); `?? 0` makes the first command of every category eligible at `t0`. If
NO category is eligible (`firstEligibleIndex` returns `-1`) every queued command
STAYS and `reconcileAlarm` re-arms for the EARLIEST per-category eligibility across
the queue (`min` over `max(lastExec+cooldown, now)` of each distinct category, NOT
just the FIFO head). Otherwise deliver the eligible command, then **re-read
`cmdQueue` FRESH** before removing it (the delivery await opened the input gate —
see Platform model — so a concurrent enqueue may have appended to the TAIL; appends
never reorder/remove and drain is the SOLE remover with only one `alarm()` per DO,
so the selected command is still at the SAME index in the fresh array).

**Delivery reuses `proxyToDashboard`** (identical `Content-Type: application/json`
+ `X-Remote-Key` + base-join as the direct path — the two paths cannot drift),
wrapped in a `DELIVER_TIMEOUT_MS` **AbortController** so a HUNG dashboard folds into
the transient bucket instead of wedging.

**HTTP-status policy** (explicit). `2xx` = **delivered** (terminal, trace
`delivered`). `4xx` = **permanently-rejected** (terminal — a 4xx is a
contract/validation error; retrying behind a 5s cooldown would just wedge the
queue; LOUD warn, trace `dashboard-rejected-<status>`, **not** logged as
`delivered`). `5xx` + fetch-reject + abort/timeout = bounded **TRANSIENT** (LOUD
warn, trace `dashboard-error-<status>` / `transient-reject` / `transient-timeout`).
Bounded-retry is an **immediate single retry** (no backoff): a transient under
`MAX_DELIVERY_ATTEMPTS` keeps the head (attempts++, **no** `lastExec` bump,
`reconcileAlarm` re-arms at `now` so the retry fires immediately); on the second
transient it is a LOUD give-up drop (trace `dropped-after-max-<lastTrace>`). On
TERMINAL or give-up the per-category `lastExec` is bumped, the head is shifted, and
the drain-trace records the REAL outcome.

**Drop accounting (truthful — every drop is LOUD, never silent).** Normal operation
truncates nothing. The ONLY drops are: (i) `MAX_QUEUE` runaway backstop, returning
the **DISTINCT** envelope `202 { ok:true, queued:false, dropped:'queue_full' }` (the
success field never lies about a drop; a future ext UI can surface backpressure);
(ii) transient-attempt exhaustion after `MAX_DELIVERY_ATTEMPTS`; (iii) a 4xx
permanent dashboard rejection (terminal); (iv) `DASHBOARD_REMOTE_BASE` unset (trace
`dropped-no-dashboard`). Note the pre-dashboard steady state: a delivery-exhausting
outage drops the command (LOUD) and the truth does **not** arrive via the WS either
(the WS upstream is equally unreachable).

All drain/drop/overflow traces are structured `{ source: 'music-do' }` via
`console.log` / `console.warn` (Cloudflare **native** Workers Logs, already enabled)
— **no** `@microlabs` OTel, no `instrument()`, no body-capture.

### Single-alarm coexistence

The DO has **exactly ONE alarm**, shared by two responsibilities — the
upstream-liveness demand-gate (now-playing fan-out) and the command-queue drain.
**`reconcileAlarm()` is the SOLE `setAlarm`/`deleteAlarm` authority** (`armAlarm()`
is gone; no other method touches the alarm directly). It computes:

- **liveness** = reads the **PERSISTED `demand` key** (NEVER `getWebSockets()`,
  which still holds a closing socket inside `webSocketClose`); `demand > 0` ?
  `now + UPSTREAM_ALARM_INTERVAL_MS` : `null`.
- **drain** = reads FRESH `cmdQueue`; `null` if empty, else the **EARLIEST
  per-category eligibility** across all distinct categories in the queue — `min`
  over `max((lastExec:<cat> ?? 0) + cooldown, now)` of each category. This MUST
  match the drain's cross-category overtaking (see **Drain order** above): an idle
  category behind a cooldown-blocked head drives the alarm to wake at *its*
  eligibility, not the blocked head's far-future time — otherwise the alarm would
  sleep out the blocked cooldown while a drainable command sits behind it.

…and sets the alarm to the **EARLIEST non-null** of the two; it **deletes only when
BOTH are null** (demand===0 AND queue empty) and **never when `armOnly`**. The
**CONSTRUCTOR** calls `reconcileAlarm({ armOnly: true })` — a fresh isolate must
never wipe an alarm a prior instance legitimately set, so it ARMS the drain for a
persisted-undrained queue (drain resumes even at demand 0 post-eviction) + ARMS
liveness for demand>0, but never deletes. Real demand-change events
(`recomputeDemandAndReconcile`) and `enqueueCommand` call `reconcileAlarm()`
without `armOnly` (those MAY legitimately delete when both responsibilities go
idle).

**Alarm ordering — LIVENESS FIRST, THEN drain.** `alarm()` is `try { liveness;
drainOneEligible(); } finally { reconcileAlarm(); }`. Liveness (a local
`readyState` check + a `getWebSockets()` fan of the persisted snapshot for demand>0,
else `closeUpstream()`) is CHEAP and runs BEFORE the up-to-`DELIVER_TIMEOUT_MS`
delivery, so the now-playing demand-gate fan is **never starved** behind a slow/hung
delivery — even when sustained command load makes the `min()` fire on a near-term
drain time, the fan happens first every wake. The `try/finally` guarantees a re-arm
even if liveness OR drain throws (the original error still propagates, so the
platform's at-least-once execution + retry-on-throw also re-drives `alarm()`). A
drain-only wake at demand 0 tears the upstream down rather than leaking it.

**Cadence consequence.** When a near-term drain is the `min`, the alarm fires
EARLIER than `UPSTREAM_ALARM_INTERVAL_MS`; the `finally` re-arms liveness at
`now + UPSTREAM_ALARM_INTERVAL_MS`, so while commands flow liveness fires MORE OFTEN
than 30s — correct and harmless (`ensureUpstream` is idempotent) but raises billed
alarm invocations. `UPSTREAM_ALARM_INTERVAL_MS` is therefore an **UPPER BOUND** on
liveness spacing, **not** a fixed period — the accepted tradeoff for the shared
alarm.

> **Load-bearing platform model** (verified against the Cloudflare DO
> rules-of-durable-objects). An **awaited `fetch()`** inside a DO handler **OPENS**
> the input gate — it does **NOT** hold it. Consequence A: the alarm's delivery
> fetch does **NOT** block a concurrently-arriving `enqueueCommand` 202 — worst-case
> 202 latency is the DO's own storage-op time (sub-ms), not `DELIVER_TIMEOUT_MS`.
> Consequence B (the real hazard the docs flag): a concurrent enqueue can mutate
> `cmdQueue` DURING the delivery await — so the **HARD invariant** is
> *read-fresh-at-the-top-of-every-op + persist-before-every-await*, and
> `drainOneEligible` **re-reads `cmdQueue` after the delivery await** before
> shifting; never cache the array across an await.

> **Self-clock platform assumption.** A `setAlarm(<= now)` from within `alarm()`
> re-fires promptly (the drain self-clock) — the queue analogue of the demand-gate's
> "armed alarm fires post-eviction" invariant. `music-do.spec.js` proves
> the HANDLER drains exactly one head per `alarm()` invocation, but
> `runInDurableObject` hands a LIVE instance and cannot prove cross-wake self-re-fire
> (the same harness limit the demand-gate already documents). `alarm()` also has
> platform at-least-once execution + retry-on-throw, which the `try/finally` re-arm
> complements.

## NowPlayingSnapshot (fanned verbatim, camelCase — never re-shaped)

```jsonc
{
  "isPlaying": true,
  "positionMs": 12000,
  "track": {              // or null
    "loadId": "…",
    "title": "…",
    "artists": "…",
    "album": "…",
    "artUrl": "…",
    "durationMs": 429000
  }
}
```

The DO persists the latest snapshot and forwards it byte-for-byte to every ext
socket. A freshly-connecting client always receives the last-known snapshot on
connect (no blank state).

## Durable Object — `MusicRemoteState` (WebSocket Hibernation)

Single instance, addressed by the fixed name `global` (music control is
single-target). SQLite-backed (`new_sqlite_classes` migration `v1`), required for
the WebSocket Hibernation API + `ctx.storage` alarms.

**This is the first WebSocket-Hibernation DO in the repo.** The prior DO
(`ExtCallState`) is RPC-only; the hibernation lifecycle here (`acceptWebSocket`,
`webSocketMessage/Close/Error`, `getWebSockets`, the alarm-heartbeat
upstream-liveness pattern, persisted-demand re-open, lazy re-open belt-and-braces)
is entirely new. Only the migration-tag style is mirrored from the root wrangler.

### Lifecycle

- **Downstream ext sockets** connect via `/music/now-playing` and are
  `acceptWebSocket()`'d so they survive isolate hibernation; the set is recoverable
  via `getWebSockets()`. Each upstream snapshot is fanned verbatim to all of them.
- **Upstream music-source socket** is opened via **plain `fetch`** and lives on the
  plain in-memory field `this.upstream`. It is **not** `acceptWebSocket()`'d (it is
  not a client of this DO). A plain field does **not** survive isolate eviction, and
  a fully-hibernated DO with no in-flight events does not wake on its own.
  - **Upstream URL is DERIVED from `DASHBOARD_REMOTE_BASE`.**
    The now-playing stream originates from the dashboard's
    **`/api/remote/nowplaying`** route — the same ingress the HTTP proxy already
    targets. `openUpstream()` `fetch`es `DASHBOARD_REMOTE_BASE` + `/api/remote/nowplaying`
    with an `Upgrade: websocket` header and reads `resp.webSocket` — the http(s)
    scheme is **kept as-is** (the Workers runtime rejects a `ws`/`wss` URL). There is **no
    separate `UPSTREAM_WS_URL` secret**. When `DASHBOARD_REMOTE_BASE` is unset (e.g.
    a test env) `openUpstream()` no-ops and the fan-out delivers **only** the
    persisted snapshot, never live events.
  - **Outbound WS auth.** The upstream WS upgrade carries the frozen
    **`X-Remote-Key`** header (= `DASHBOARD_REMOTE_KEY`), mirroring the HTTP proxy
    (`proxy.js`) — the upstream IS the dashboard, so the upgrade satisfies the
    contract's outbound-auth requirement. The header is omitted only when
    `DASHBOARD_REMOTE_KEY` is unset.
  - **Unreachable dashboard degrades gracefully — reject AND hang are both bounded.**
    If the upstream `fetch` rejects (DNS failure / cold or absent ingress — the
    expected steady state while the dashboard is built in parallel, the same
    condition the HTTP proxy maps to a 502), `openUpstream()` logs and leaves
    `upstream` null rather than throwing; the demand-gate keeps the alarm armed so
    the next interval (or a reconnecting / message-sending subscriber) retries. The
    **accept-then-hang** case is bounded too: the upstream upgrade hits the SAME
    dashboard ingress as command delivery and has the SAME hang hazard, so the fetch
    is wrapped in an **`UPSTREAM_OPEN_TIMEOUT_MS` AbortController** (mirroring
    delivery's `DELIVER_TIMEOUT_MS`). This matters most because `openUpstream()` is
    awaited inside the constructor's `blockConcurrencyWhile` — an unbounded hung
    handshake there would stall the DO from servicing **any** request (every
    consumer's enqueue / ws-ticket / upgrade blocks). On abort the fetch rejects and
    folds into the SAME `upstream`-null catch as a connection reject (a distinct
    "timed out" warn message) — identical degrade-gracefully outcome, now covering a
    hang.

### Demand-gate (the load-bearing mechanism)

- Demand is **persisted** to `ctx.storage` (survives eviction), **not** inferred
  from the plain upstream field. `demand = getWebSockets().length`, recomputed +
  persisted on every accept and `webSocketClose`. **Upstream is open IFF demand ≥ 1.**
- The cadence is a **named module-level constant `UPSTREAM_ALARM_INTERVAL_MS = 30_000`**
  (not an inline 30 s). Rationale: a balance between post-eviction reconnect latency
  (longer → a now-playing change can sit unfanned up to one interval) and wasted
  wakeups when idle (shorter → more billed alarm invocations on an idle-but-subscribed
  DO). Since the command queue shipped, this is an **UPPER BOUND** on liveness
  spacing, not a fixed period (see **Single-alarm coexistence** → Cadence
  consequence): while commands flow the shared `min()` alarm can fire liveness
  earlier than 30s, then re-arm.
- While demand > 0 a liveness alarm is kept armed up to `UPSTREAM_ALARM_INTERVAL_MS`
  ahead. `alarm()` re-opens upstream if it died during an eviction gap, re-fans the
  persisted snapshot to any reconnected clients, and re-arms. When demand hits 0 it
  closes upstream. **The single alarm is shared with the command-queue drain** and
  is owned exclusively by `reconcileAlarm()` (it sets the EARLIEST of liveness +
  drain, and deletes only when demand===0 AND the queue is empty); see **Single-alarm
  coexistence** above for the full ordering + the input-gate platform model.

### ⚠️ Load-bearing platform invariant

> An armed `ctx.storage` alarm **fires for a DO whose isolate has been evicted**,
> and accepted-but-idle hibernatable WebSockets do **not** block that alarm from
> firing.

This is the single platform assumption the demand-gate rests on. `alarm()` is the
only mechanism that reliably re-runs a fully-hibernated DO whose subscribers are
idle (no message traffic). If Cloudflare hibernation semantics ever change this,
the demand-gate breaks — a future maintainer should know exactly what to check.

### Belt-and-braces lazy re-open

Because `runInDurableObject` (vitest-pool-workers) hands a **live** instance and
cannot evict a real isolate, the alarm test proves the **handler** re-opens but
cannot prove the **platform** fires an alarm post-eviction with idle sockets
attached. To remove that single point of failure, upstream is **also** re-checked /
re-opened lazily at the top of the WS-upgrade handler **and** at the top of
`webSocketMessage` — a reconnecting or message-sending subscriber forces re-open
even if an alarm lapsed. Liveness survives an alarm **gap**, not only an alarm.

### Test harness note — `isolatedStorage: false`

`music-worker/vitest.config.js` sets `isolatedStorage: false` (with `singleWorker:
true`). The DO holds **long-lived hibernatable WebSockets** that stay open past the
end of the test that opened them; with `isolatedStorage: true`,
vitest-pool-workers tries to pop the DO's storage stack frame after each test and
asserts on a clean `.sqlite` handle, which an open socket keeps live — the pop then
fails ("Failed to pop isolated storage stack frame … unable to pop Durable Objects
storage"). Each DO test addresses a **unique `idFromName`**, so there is no
cross-test state to isolate. (cache-worker also runs `isolatedStorage: false`, for a
different — Workflows — incompatibility.)

## Auth

Extension → music worker uses the **existing extension scheme** (frozen contract):
Cloudflare Access **App 2** (SaaS-OIDC PKCE) JWT, or the legacy
`X-Extension-Token` vs `LINKEDIN_EXTENSION_SECRET`.

- `src/access-auth.js` is a copy of the **MAIN worker** `src/access-auth.js`
  (4-arg `verifyAccessJwt(request, env, expectedAud, opts)` with `opts.issuer` /
  `opts.jwksUrl`, per-URL JWKS cache, RS256-only). It is **explicitly NOT** a copy
  of `mcp-remote/src/access-auth.ts`, which is the **App-1** self-hosted shape
  (hardcoded team-wide `/cdn-cgi/access/certs` JWKS, `iss = ACCESS_TEAM_DOMAIN`,
  single aud, no opts) — copying it would reject every real App-2 extension token.
  A `_MODULE_ID = 'music-worker/access-auth'` sentinel guards against resolver
  fallback.
- `src/auth-music.js` is a trimmed `authExtensionRequest`. It keeps the
  load-bearing guards — (a) **fail-safe**: if `ACCESS_AUD_MIDDLEWARE` **or**
  `ACCESS_CLIENT_ID_MIDDLEWARE` is unset/empty, the JWT branch is skipped and the
  request falls through to legacy (without this, `audience: undefined` would
  silently accept any team token, incl. App-1/MCP); (b) **present-but-invalid
  JWT → 401 `auth_jwt_invalid`**, no fall-through; (c) legacy
  `X-Extension-Token`. It drops the OTel surface **and** the identity gate.
- **JWT-only (no identity gate).** A validly-signed Access JWT (correct issuer +
  audience) is the authorization — there is **no `USERS_DB` lookup, no
  email-registry check, no `ACCESS_ALLOWED_EMAILS`**. Cloudflare Access already
  restricts token issuance to the team, so a valid App-2 JWT IS a teammate. The
  result is `{ ok: true, source: 'jwt', email, sub }` for any valid token. This is
  a deliberate design decision for this worker — the music remote carries no
  per-user authorization, only team membership.

### WS-upgrade auth (Option B)

The WS path does **not** carry a token in the URL/query (CF logs persist query
strings). Instead:

1. The extension `POST`s `/music/ws-ticket` (auth-gated). The DO mints a
   **single-use, short-TTL ticket** (`WS_TICKET_TTL_MS = 30_000`) into
   `ctx.storage` (strong-consistent).
2. The extension upgrades `/music/now-playing` presenting the ticket as a
   `Sec-WebSocket-Protocol` value (`rf-music.v1, ticket.<id>`). The DO redeems it
   (delete-on-read, TTL-checked) before `acceptWebSocket`.

One extension-auth surface; the secret never lands in a URL or log. The alternative
considered and rejected was Option A — a separate Access app fronting only the WS
path — which adds a third auth surface plus its own hostname and audience.

## Config (`wrangler.music.jsonc`)

- `name: rf-music-remote`, `main: src/index.js`, `compatibility_date: 2026-05-10`,
  `compatibility_flags: ["nodejs_compat"]`.
- `workers_dev: true` — the extension reaches this worker from the browser over the
  public internet (`PLASMO_PUBLIC_MUSIC_URL`), so unlike cache-worker
  (`workers_dev:false`, binding-only) the public subdomain stays enabled. A later
  custom domain becomes the `PLASMO_PUBLIC_MUSIC_URL`.
- `vars.ACCESS_TEAM_DOMAIN` only (no `LD_OTLP_*`).
- `durable_objects.bindings: [{ name: MUSIC_REMOTE, class_name: MusicRemoteState }]`,
  `migrations: [{ tag: v1, new_sqlite_classes: ["MusicRemoteState"] }]`.
- **No `d1_databases`** — auth is JWT-only; there is no `USERS_DB` identity gate.

### Secrets (Cloudflare dashboard — never in wrangler config)

| Secret | Purpose |
| --- | --- |
| `LINKEDIN_EXTENSION_SECRET` | legacy `X-Extension-Token` (= main worker value) |
| `ACCESS_AUD_MIDDLEWARE` | App-2 redirect URI(s), comma-separated |
| `ACCESS_CLIENT_ID_MIDDLEWARE` | App-2 SaaS-OIDC client_id |
| `DASHBOARD_REMOTE_KEY` | outbound `X-Remote-Key` to the dashboard |
| `DASHBOARD_REMOTE_BASE` | dashboard ingress base URL (recommend secret). Also the **upstream now-playing WS source** — the DO derives `ws(s)://…/api/remote/nowplaying` from it |

`ACCESS_AUD_MIDDLEWARE` **and** `ACCESS_CLIENT_ID_MIDDLEWARE` must both be set or the
fail-safe drops the JWT path to legacy-only.

### Extension side (operator)

Set `PLASMO_PUBLIC_MUSIC_URL` to the `rf-music-remote` URL.

## Install / verify (independent install root — NOT an npm workspace)

`music-worker` is an independent install root mirroring the siblings: a committed
`package-lock.json`, a gitignored `node_modules/`, and an explicit `npm install`.

```bash
# step 0 — install (cwd = music-worker/)
npm install
# step 1 — tests
npm test            # vitest run
# step 2 — config validation only (NEVER deploy)
npx wrangler deploy --dry-run -c music-worker/wrangler.music.jsonc
```

## Open operator items (escalations)

1. ~~**Dashboard `/api/remote/*` sub-paths**~~ — **RESOLVED.** The 11 sub-paths are
   confirmed against the dashboard's actual routes (see the Outbound table above)
   and wired into `API_REMOTE_PATH`. `throwIfUnset()` is retained as a safety net.
2. ~~**Identity gate**~~ — **RESOLVED: JWT-only per operator.** The identity gate
   is dropped: a valid Cloudflare Access JWT is the authorization (Access already
   restricts issuance to the team). No `USERS_DB` binding, no email registry, no
   `ACCESS_ALLOWED_EMAILS`.
3. **WS-upgrade auth A vs B** — Option B (DO ticket store) is the default; Option A
   (separate Access app fronting the WS path) is the alternative (adds a third auth
   surface + hostname/AUD).
4. **Ops / secrets / hostname** — create the `rf-music-remote` worker + hostname,
   set the secrets above, set `PLASMO_PUBLIC_MUSIC_URL`. (No `USERS_DB` binding —
   auth is JWT-only, escalation 2.)
5. ~~**Upstream now-playing WS source + its auth**~~ — **RESOLVED.** The upstream is
   the dashboard's **`/api/remote/nowplaying`** route at
   `DASHBOARD_REMOTE_BASE` + the path, opened via `fetch` + an `Upgrade: websocket`
   header (the http(s) scheme is kept — Workers rejects `ws`/`wss`). The upgrade
   carries the frozen **`X-Remote-Key`** (= `DASHBOARD_REMOTE_KEY`), exactly as the
   HTTP proxy does. There is no separate `UPSTREAM_WS_URL`; when
   `DASHBOARD_REMOTE_BASE` is unset, `openUpstream()` no-ops and only the persisted
   snapshot is fanned.
