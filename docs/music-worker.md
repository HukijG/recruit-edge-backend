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

| Route | Method | Body / query | Notes |
| --- | --- | --- | --- |
| `/music/pause` | POST | `{}` | transport |
| `/music/resume` | POST | `{}` | transport |
| `/music/next` | POST | `{}` | transport |
| `/music/prev` | POST | `{}` | transport |
| `/music/volume` | POST | `{ direction: "up" \| "down" }` | mapped to a **server-fixed ±10 percentage-point** delta; magnitude is never client-supplied |
| `/music/play` | POST | `{ id: <numeric Deezer id> }` | id validated numeric → 400 otherwise |
| `/music/enqueue` | POST | `{ id: <numeric Deezer id> }` | id validated numeric |
| `/music/playlist-play` | POST | `{ id: <numeric Deezer id> }` | id validated numeric |
| `/music/search` | GET | `?q=<free text>` | idempotent read |
| `/music/playlist-search` | GET | `?q=<free text>` | idempotent read |
| `/music/playlist-contents` | GET | `?id=<numeric Deezer id>` | id validated numeric |
| `/music/ws-ticket` | POST | — | auth-gated; issues a single-use WS ticket (see WS auth) |
| `/music/now-playing` | GET (Upgrade: websocket) | — | now-playing fan-out; the **DO redeems the subprotocol ticket** (no header auth that would leak into a URL/log) |
| `/health` | GET | — | unauthenticated liveness |

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
fires. The frozen bits (X-Remote-Key, `DASHBOARD_REMOTE_BASE`, volume ±10, Deezer
numeric ids) are hard-coded.

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
error handling stays uniform regardless of dashboard availability.

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
    targets. `openUpstream()` derives the WS URL from `DASHBOARD_REMOTE_BASE`
    (`http`→`ws`, `https`→`wss`) and appends `/api/remote/nowplaying`. There is **no
    separate `UPSTREAM_WS_URL` secret**. When `DASHBOARD_REMOTE_BASE` is unset (e.g.
    a test env) `openUpstream()` no-ops and the fan-out delivers **only** the
    persisted snapshot, never live events.
  - **Outbound WS auth.** The upstream WS upgrade carries the frozen
    **`X-Remote-Key`** header (= `DASHBOARD_REMOTE_KEY`), mirroring the HTTP proxy
    (`proxy.js`) — the upstream IS the dashboard, so the upgrade satisfies the
    contract's outbound-auth requirement. The header is omitted only when
    `DASHBOARD_REMOTE_KEY` is unset.
  - **Unreachable dashboard degrades gracefully.** If the upstream `fetch` rejects
    (DNS failure / cold or absent ingress — the expected steady state while the
    dashboard is built in parallel, the same condition the HTTP proxy maps to a
    502), `openUpstream()` logs and leaves `upstream` null rather than throwing; the
    demand-gate keeps the alarm armed so the next interval (or a reconnecting /
    message-sending subscriber) retries.

### Demand-gate (the load-bearing mechanism)

- Demand is **persisted** to `ctx.storage` (survives eviction), **not** inferred
  from the plain upstream field. `demand = getWebSockets().length`, recomputed +
  persisted on every accept and `webSocketClose`. **Upstream is open IFF demand ≥ 1.**
- The cadence is a **named module-level constant `UPSTREAM_ALARM_INTERVAL_MS = 30_000`**
  (not an inline 30 s). Rationale: a balance between post-eviction reconnect latency
  (longer → a now-playing change can sit unfanned up to one interval) and wasted
  wakeups when idle (shorter → more billed alarm invocations on an idle-but-subscribed
  DO).
- While demand > 0 an alarm is kept armed `UPSTREAM_ALARM_INTERVAL_MS` ahead.
  `alarm()` re-opens upstream if it died during an eviction gap, re-fans the
  persisted snapshot to any reconnected clients, and re-arms. When demand hits 0 it
  closes upstream and `deleteAlarm()`.

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
   the dashboard's **`/api/remote/nowplaying`** route, derived from
   `DASHBOARD_REMOTE_BASE` (`http`→`ws` / `https`→`wss` + the path). The upgrade
   carries the frozen **`X-Remote-Key`** (= `DASHBOARD_REMOTE_KEY`), exactly as the
   HTTP proxy does. There is no separate `UPSTREAM_WS_URL`; when
   `DASHBOARD_REMOTE_BASE` is unset, `openUpstream()` no-ops and only the persisted
   snapshot is fanned.
