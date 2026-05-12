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
| **App 2** | ⏳ Pending (Spec B) | `rf-dialpad-sync-dev` (extension API) | TBD | `ACCESS_AUD_MIDDLEWARE` (secret, not yet set) | First in Access-for-SaaS / OIDC mode (issues tokens, doesn't gate worker) so legacy and new extension builds coexist; later switched to fronted self-hosted with path filter excluding `/webhook/*` |

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
- ⏳ **Spec B (extension migration)** — pending. Cloudflare-side middleware prep (dual-auth helper, App 2 in SaaS-OIDC mode, then Phase 3 cutover to fronted self-hosted). Extension OAuth client is a separate workstream owned by Joel.
- ⏳ **Drop transitional `consultantFirstName` body fallback** in `src/mcp/router.js` — when Spec B Phase 3 confirms zero `[mcp] legacy consultantFirstName fallback` log lines.

## References

- [Spec A — Cloudflare Access for MCP](archive/specs/2026-05-10-cloudflare-access-mcp-design.md)
- [Spec B — Cloudflare Access for the extension API](archive/specs/2026-05-10-cloudflare-access-extension-design.md)
- [Plan A — implementation step list (manual + code)](archive/plans/2026-05-10-cloudflare-access-mcp.md)
- [Plan B — implementation step list](archive/plans/2026-05-10-cloudflare-access-extension.md)

## Tangentially-related open work

### Cron re-enable scope

The cache-worker cron trigger remains commented out in `cache-worker/wrangler.cache.jsonc` as of this branch (the `"triggers"` block is present but commented). Re-enable is cutover step 2 (operator-driven, after migration `0003_v2_tables.sql` is applied and the new cache-worker code is deployed).

**Two paths exist side-by-side during the dual-write phase, both gated by env vars on cache-worker:**

- **Legacy `tailSync`** — fires only when `CRON_LEGACY_ENABLED='true'` (or `'1'`) is set as a Worker secret/var on cache-worker. Default `'false'`. Writes to the legacy `candidates`, `candidate_jobs`, `jobs`, `job_pipelines` tables (REPLACE-everything semantics, same as before). Intentionally inert during the dual-write window because it drives the ~1M D1 writes/day storm the redesign exists to fix — only set to `'true'` if the operator needs to fall back to legacy writes during a cutover emergency.
- **New `tailSyncThin`** — fires only when `CRON_THIN_ENABLED='true'` (or `'1'`) is set as a Worker secret/var on cache-worker. Default `'false'`. Additive-only INSERT-OR-IGNORE into `candidates_v2`, `jobs_v2`, `calls`. Operator sets this to `'true'` at cutover step 5, after verifying the new tables were seeded by `/admin/cache-rebuild` and the main worker is reading from the thin tables without errors.

Both gates default to `'false'` so re-enabling the cron trigger at step 2 does not automatically activate either write path. The operator opts in explicitly — `CRON_THIN_ENABLED='true'` at step 5; `CRON_LEGACY_ENABLED` stays `'false'` throughout normal cutover (the legacy path is functionally gone from step 2 onward).

Both paths write to disjoint table sets until cutover step 6 drops the legacy tables. After step 6, the legacy `tailSync` function is removed and both env-var gates become redundant (they're removed alongside the dual-path cleanup). The cron bypasses Access entirely — it writes nothing through user-facing routes.

Not auth-related per se, but tracked here so re-enabling cron during auth work doesn't surface as unexpected unauthenticated traffic.

**Cross-reference:** Full cutover sequence (steps 1–6) in the thin-immutable-cache implementation plan, Tasks 20–25.

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
