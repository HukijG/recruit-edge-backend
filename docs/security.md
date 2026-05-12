# Security & Auth

Canonical reference for the auth layer across the workers + the convention all new user-facing routes must follow. **Read this before adding/touching any user-accessible endpoint, any auth header, or anything wired to identity (consultant attribution, calendar logic, RF user-id resolution).**

## Convention — non-negotiable

**Every user-facing endpoint goes through Cloudflare Access OAuth. No exceptions.**

- Any route a teammate hits via browser, AI client (claude.ai connector, claude desktop), or Chrome extension is "user-facing" and must be Access-protected.
- Identity is the verified `email` claim from the Access JWT. Resolve it server-side via `getUserByEmail(env, email)`; never accept identity claims from request bodies.
- Don't add new shared-secret headers, IdP-of-the-week integrations, body-field identity ("consultantFirstName"-style), or any parallel auth mechanism. They will fragment trust and not survive Spec B's cutover.
- Webhook endpoints (Dialpad / RF / Krisp / calendar) are NOT user-facing. They keep their existing auth (Dialpad JWT signature, RF URL-secret, Krisp signature, calendar webhook secrets).
- Service-binding traffic between workers is implicitly trusted within the Cloudflare account boundary. The upstream (Access-protected) worker validates the JWT once and forwards a body field with the verified identity to the downstream worker.
- The **one exception** to pure trust-within-account: the cache-worker's `/internal/*` routes add a shared-secret gate (`X-Internal-Token`) on top of service-binding trust as defense-in-depth. See below.

If you're unsure whether a new endpoint needs Access:

| Caller | Behind Access? |
|---|---|
| Teammate via browser, extension, or AI client | **Yes** |
| Cloudflare-side webhook (Dialpad / RF / etc.) | No — keep existing webhook auth |
| Another internal worker over service binding | No — binding origin is trusted; pass identity in body. Add `X-Internal-Token` only when the receiver is cache-worker `/internal/*` (belt-and-braces against Workers Routes / custom domain re-exposure) |
| Cron / scheduled handler | No — there's no user identity |

## Current implementation

### Identity layer

- **Provider**: Cloudflare Access (Zero Trust Free plan, ≤50 seats).
- **Team domain**: `example-team.cloudflareaccess.com`.
- **Login method**: One-Time PIN (email OTP). Configured in Zero Trust → Integrations → Identity providers. Coexists with whatever other IdPs the team already uses for unrelated apps; per-app policies pick which IdPs apply.
- **Reusable Policy `rf-team`**: Action = Allow; Include rule = `Emails ending in @<your-team-domain>`. Action attached from any Access Application that wants to authorize teammates.

### Application registrations

| App | Status | Worker | URL | AUD env var | Notes |
|---|---|---|---|---|---|
| **App 1** | ✅ Live | `rf-mcp-remote` | `rf-mcp-remote.<account>.workers.dev` (hostname-only — Managed OAuth requires no path) | `ACCESS_AUD_MCP` (secret) | Self-hosted, Managed OAuth ON, DCR enabled, allowed redirect URI `https://claude.ai/api/mcp/auth_callback` |
| **App 2** | ✅ Phase 2 (code live; dashboard config + secret operator-pending) | `rf-dialpad-sync-dev` (extension API) | TBD | `ACCESS_AUD_MIDDLEWARE` (secret, operator-pending) | Phase 2 dual-auth helper shipped in `src/auth-extension.js`. Cloudflare Access App 2 dashboard creation, `ACCESS_AUD_MIDDLEWARE` secret set, and the operator's separate extension build remain. Phase 3 (legacy header removal + edge gating) is future work. |

### Extension OAuth client contract (App 2)

App 2's OAuth client is consumed by the operator's separate extension workstream. This is the frozen contract — values are captured at App 2 creation and don't change across Phase 2 → Phase 3.

| Property | Value |
|---|---|
| Authorization endpoint | `https://example-team.cloudflareaccess.com/cdn-cgi/access/sso/oauth2/<client_id>/authorize` |
| Token endpoint | `https://example-team.cloudflareaccess.com/cdn-cgi/access/sso/oauth2/<client_id>/token` |
| Grant type | `authorization_code` + `refresh_token` |
| PKCE | Required (`code_challenge_method=S256`, verifier ≥ 256 bits randomness) |
| Client type | Public (no `client_secret`) |
| Client ID | Captured at App 2 creation |
| Redirect URI | `https://<chrome-extension-id>.chromiumapp.org/oauth-callback` (multiple allowed) |
| Audience | `<ACCESS_AUD_MIDDLEWARE>` |
| Scopes | `openid email profile` |
| Token storage | Operator's choice; refresh on 401, "needs reconnect" on refresh failure |
| Outbound header | `Authorization: Bearer <access_token>` |

### Code surface

- **JWT validation helper** — same shape, two languages:
  - `src/access-auth.js` (main worker, JS)
  - `mcp-remote/src/access-auth.ts` (MCP worker, TS)
  - Public API: `verifyAccessJwt(request, env, expectedAud) → Promise<{ email, sub } | null>`. Reads `Cf-Access-Jwt-Assertion` header first, falls back to `Authorization: Bearer`. Validates RS256 signature against Access JWKS, issuer = `env.ACCESS_TEAM_DOMAIN`, audience = `expectedAud`. Empty-string defense on email/sub. Returns lowercased email.
  - Test fixture (mcp-remote side): `mcp-remote/test/jwt-fixture.ts` — RSA keypair, JWKS injection via `_setJwksForTests`, signed-JWT minting with optional `aud` / `iss` overrides.
  - The mcp-remote file has an exported `_MODULE_ID = "mcp-remote/access-auth"` sentinel; the test asserts it in `beforeAll` to guard against vite resolving the import to the main worker's file via relative-path fallback.

- **Env vars**:
  - `ACCESS_TEAM_DOMAIN` — non-secret, set as `vars` in `wrangler.jsonc` + `wrangler.mcp.jsonc`. Currently `https://example-team.cloudflareaccess.com`.
  - `ACCESS_AUD_MCP` — secret, set on `rf-mcp-remote` via `wrangler secret put`. 64-char hex tag from the App 1 dashboard.
  - `ACCESS_AUD_MIDDLEWARE` — secret, set on `rf-dialpad-sync-dev` when Spec B lands.

- **Implementation hardening — `ACCESS_AUD_MIDDLEWARE`-unset fail-safe** (see `src/auth-extension.js`):
  - When `env.ACCESS_AUD_MIDDLEWARE` is unset or empty, the JWT branch in `authExtensionRequest` is skipped entirely — the helper falls through to the legacy `X-Extension-Token` path.
  - This guard is load-bearing: without it, `jose.jwtVerify` called with `audience: undefined` would silently accept any team-domain token, including App 1's MCP tokens (`ACCESS_AUD_MCP`), against the middleware. An operator who sets `ACCESS_AUD_MIDDLEWARE` to an empty string would otherwise open a cross-app token acceptance hole.
  - When the secret is unset, a one-shot isolate-level `console.warn` fires (`[auth] ACCESS_AUD_MIDDLEWARE not configured — JWT path skipped, falling through to legacy`). This is a diagnostic, not an error; the legacy path keeps working normally.

- **Identity flow (MCP path, live)**:
  ```
  claude.ai connector
    └── DCR + OAuth (PKCE, S256) ──▶ example-team.cloudflareaccess.com
                                        └── OTP login ──▶ JWT issued (aud = ACCESS_AUD_MCP)
  claude.ai
    └── POST /mcp + Authorization: Bearer <jwt> ──▶ rf-mcp-remote
                                                       └── verifyAccessJwt(req, env, ACCESS_AUD_MCP)
                                                       └── service binding ──▶ rf-dialpad-sync-dev
                                                                                  └── /mcp/* router
                                                                                        └── getUserByEmail(env, claims.email)
  ```

### Identity store (`USERS_DB.users`)

- Owned by the **main worker** (writes via `migrations/`, reads via `src/users.js`). Distinct from `RF_MCP_CACHE` (cache-worker-owned) — the "only cache worker writes D1" invariant scopes to `RF_MCP_CACHE`.
- Schema: see [`migrations/0001_create_users.sql`](../migrations/0001_create_users.sql). `email TEXT PRIMARY KEY` with CHECK lowercase + LIKE `'%@%.%'`. UNIQUE indexes on `dialpad_id`, `rf_user_id`, `first_name`. CHECK constraint on `calendar_mode IN ('outlook', 'gcal', 'both')`.
- Seed: see [`migrations/0002_seed_users.sql`](../migrations/0002_seed_users.sql) (placeholder emails — substitute at apply-time).
- Module: [`src/users.js`](../src/users.js) — async, env-first, module-level cache (single bulk SELECT per Worker isolate, never invalidated within an isolate). Adding a teammate = a new migration applied via `wrangler d1 execute --remote`, then redeploy the workers (cold start refreshes the cache).

## Service-binding endpoints (no Access required, but see below)

### `POST /internal/calls/upsert` (cache-worker)

- **Worker:** `rf-mcp-cache-sync` (cache-worker)
- **Caller:** `rf-dialpad-sync-dev` (main worker) via `SYNC_WORKER` service binding — triggered from `src/webhook/dialpad-hangup-forwarder.js` inside `ctx.waitUntil` on every hangup event.
- **Implementation:** `handleInternal()` in `cache-worker/src/index.js`. Validates the token via `timingSafeEqual` against `env.INTERNAL_SECRET`, then calls `writeCalls(env, [payload])` — an INSERT-OR-IGNORE into the `calls` table.

**Two-layer auth (belt-and-braces):**

1. **`workers_dev: false`** in `cache-worker/wrangler.cache.jsonc` — the `https://rf-mcp-cache-sync.<account>.workers.dev/*` public subdomain is disabled. The cache-worker is reachable only via service binding and cron triggers; no internet traffic can reach `/internal/*` at the workers.dev hostname.
2. **`X-Internal-Token: env.INTERNAL_SECRET`** shared-secret header — `handleInternal` requires this on every `/internal/*` request. Defense-in-depth: the workers.dev hostname check is a Cloudflare platform guarantee; the secret gate ensures the endpoint stays gated even if a Workers Route or custom domain accidentally re-exposes the worker later.

**Why two layers?** The spec (rev 5) originally assumed `workers_dev: false` was sufficient because the Cloudflare account boundary is trusted. A review pass noted that the workers.dev subdomain was enabled by default, and that Workers Routes or a custom domain could re-expose the routes without the developer noticing. The shared secret is the explicit human-legible gate; `workers_dev: false` is the platform guarantee.

**Operator action required at deploy time:** `INTERNAL_SECRET` must be set as a Worker secret on **both** `rf-dialpad-sync-dev` and `rf-mcp-cache-sync` using the **same value**, via the Cloudflare dashboard → Workers → Settings → Variables and Secrets → `INTERNAL_SECRET`. Without this:
- `handleInternal` returns 401 on every service-binding call.
- The hangup forwarder silently skips forward (logs a warning: `INTERNAL_SECRET not set — skipping forward`).
- The calls cache stops receiving live updates from the hangup webhook. Cron tail-sync backfills within 15 minutes — not a data-loss scenario, but real-time freshness is lost for that deploy window.

**Failure mode (forward dropped):** The forwarder uses `ctx.waitUntil` and catches all errors — the hangup webhook always returns 200. If the forward fails, the cron tail-sync backstop writes the call within ~15 minutes. No durable queue; drop-and-rely-on-cron is the explicit design choice (see spec rev 5 "drop after one attempt, rely on cron").

**Cross-reference:** Data flow for calls cache (who writes what, INSERT-OR-IGNORE semantics, calls table schema) lives in `docs/architecture.md`.

### `POST /admin/cache-rebuild` (cache-worker)

- **Worker:** `rf-mcp-cache-sync` (cache-worker)
- **Auth:** `X-Admin-Token: env.ADMIN_SECRET` (shared secret, unchanged from prior design).
- **Effect:** Creates a `CacheSeedWorkflow` instance that paginates RF + Dialpad and INSERTs into the thin-immutable tables (`candidates_v2`, `jobs_v2`, `calls`).

**Invocation method change:** `workers_dev: false` on cache-worker means the prior `curl https://rf-mcp-cache-sync.<account>.workers.dev/admin/cache-rebuild?...` URL no longer works. Operators must use one of:

1. **`wrangler dev --remote`** in the `cache-worker/` subtree, then `curl localhost:8787/admin/cache-rebuild?table=<candidates|jobs|calls>` (preferred for interactive dev-loop).
2. **Cloudflare Workflows API** (preferred for cutover — no code changes):
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $CF_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"params": {"table": "candidates"}}' \
     "https://api.cloudflare.com/client/v4/accounts/<account_id>/workflows/rf-mcp-cache-seed/instances"
   ```
3. **Service binding from main worker** with a temporary admin route (operator decision; requires a deploy).

**X-Admin-Token is still required** when reaching the endpoint via `wrangler dev --remote` (option 1) — the `handleAdmin` gate is unchanged.

---

## State — what's done, what's pending

- ✅ **Spec A (MCP path)** — landed 2026-05-10. Plan A all 14 tasks complete. claude.ai connector live via DCR + OTP. `MCP_EXTENSION_SECRET` deleted from both workers.
- ✅ **Phase 2 code shipped** — branch `worktree-access-extension-phase2` (awaiting operator merge + push). Helper at `src/auth-extension.js` accepts both Cloudflare Access JWTs (`aud=ACCESS_AUD_MIDDLEWARE`) and the legacy `X-Extension-Token` header. Per-route refactor complete at `src/index.js` (all 12 user-facing routes). Dashboard config (Access App 2 creation), `ACCESS_AUD_MIDDLEWARE` secret, and the operator's separate extension build remain pending — see `docs/archive/handoffs/2026-05-12-extension-access-app2-config.md`.
- ⏳ **Phase 3 (legacy header removal + edge gating)** — future work. Triggered by operator-confirmed 24-hour drain of `auth.source=legacy` in LD after extension rollout completes. Phase 3 drops the legacy `X-Extension-Token` branch, deletes `LINKEDIN_EXTENSION_SECRET`, and switches App 2 to fronted self-hosted mode with path filter excluding `/webhook/*` and `/test/coldcall`.
- ⏳ **Drop transitional `consultantFirstName` body fallback** in `src/mcp/router.js` — when Phase 3 confirms zero `[mcp] legacy consultantFirstName fallback` log lines.

## References

- [Spec A — Cloudflare Access for MCP](archived/specs/2026-05-10-cloudflare-access-mcp-design.md) (shipped, archived)
- [Plan A — implementation step list (manual + code)](archived/plans/2026-05-10-cloudflare-access-mcp.md) (shipped, archived)
- [Spec B — Cloudflare Access for the extension API](archive/specs/2026-05-10-cloudflare-access-extension-design.md) (pending)
- [Plan B — implementation step list](archive/plans/2026-05-10-cloudflare-access-extension.md) (pending)

## Tangentially-related open work

### Cron re-enable scope (current state)

The cache-worker cron is live (`*/15 * * * *`) since 2026-05-12. Two env-var gates on cache-worker control which write path runs:

- **`CRON_THIN_ENABLED='true'`** (default, set 2026-05-12 as cutover step 5) — runs `tailSyncThin`: additive INSERT-OR-IGNORE into `candidates_v2`, `jobs_v2`, `calls`. The active and only writing path.
- **`CRON_LEGACY_ENABLED='false'`** (default, unchanged) — keeps the legacy `tailSync` inert. The legacy writers caused the ~1M D1 writes/day storm the redesign exists to fix; only flip to `'true'` for emergency rollback during cutover.

After cutover step 6 drops the legacy tables (`candidates`, `candidate_jobs`, `jobs`, `job_pipelines`) via `0004_drop_legacy.sql`, the legacy `tailSync` function is removed and both env-var gates become redundant (they're removed alongside the dual-path cleanup).

The cron bypasses Access entirely — it writes nothing through user-facing routes. Tracked here so future auth changes don't surface its traffic as unexpected unauthenticated load.

**Cross-reference:** Cutover sequence (steps 1–6) in the thin-immutable-cache implementation plan, Tasks 20–25.

### D1 PITR rollback plan

Cutover step 6 drops the legacy tables (`candidates`, `candidate_jobs`, `jobs`, `job_pipelines`) via `0004_drop_legacy.sql`. The migration file is staged in `cache-worker/migrations-pending/` during the dual-write phase so `wrangler d1 migrations apply` does NOT pick it up alongside `0003` at cutover step 1. At step 6, `git mv` it back into `cache-worker/migrations/` and then run `wrangler d1 migrations apply --remote`. This is irreversible via the migration tool — once applied, recovery requires a D1 export/restore.

**Before applying `0004_drop_legacy.sql`**, take a fresh D1 export:

```bash
npx wrangler d1 export RF_MCP_CACHE --remote --config wrangler.cache.jsonc \
  --output=backups/rf-mcp-cache-pre-drop-$(date -I).sql
```

**Recovery procedure** if cutover step 6 needs to be reverted:

```bash
npx wrangler d1 execute RF_MCP_CACHE --remote \
  --config wrangler.cache.jsonc \
  --file=backups/rf-mcp-cache-pre-drop-<date>.sql
```

Dry-run the restore command against a local D1 (`--local`) before the live cutover to verify the export is valid and the restore completes without errors.
