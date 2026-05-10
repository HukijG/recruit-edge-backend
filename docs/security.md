# Security & Auth

Canonical reference for the auth layer across the workers + the convention all new user-facing routes must follow. **Read this before adding/touching any user-accessible endpoint, any auth header, or anything wired to identity (consultant attribution, calendar logic, RF user-id resolution).**

## Convention — non-negotiable

**Every user-facing endpoint goes through Cloudflare Access OAuth. No exceptions.**

- Any route a teammate hits via browser, AI client (claude.ai connector, claude desktop), or Chrome extension is "user-facing" and must be Access-protected.
- Identity is the verified `email` claim from the Access JWT. Resolve it server-side via `getUserByEmail(env, email)`; never accept identity claims from request bodies.
- Don't add new shared-secret headers, IdP-of-the-week integrations, body-field identity ("consultantFirstName"-style), or any parallel auth mechanism. They will fragment trust and not survive Spec B's cutover.
- Webhook endpoints (Dialpad / RF / Krisp / calendar) are NOT user-facing. They keep their existing auth (Dialpad JWT signature, RF URL-secret, Krisp signature, calendar webhook secrets).
- Service-binding traffic between workers is implicitly trusted within the Cloudflare account boundary. The upstream (Access-protected) worker validates the JWT once and forwards a body field with the verified identity to the downstream worker.

If you're unsure whether a new endpoint needs Access:

| Caller | Behind Access? |
|---|---|
| Teammate via browser, extension, or AI client | **Yes** |
| Cloudflare-side webhook (Dialpad / RF / etc.) | No — keep existing webhook auth |
| Another internal worker over service binding | No — binding origin is trusted; pass identity in body |
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
  - `mcp-worker/src/access-auth.ts` (MCP worker, TS)
  - Public API: `verifyAccessJwt(request, env, expectedAud) → Promise<{ email, sub } | null>`. Reads `Cf-Access-Jwt-Assertion` header first, falls back to `Authorization: Bearer`. Validates RS256 signature against Access JWKS, issuer = `env.ACCESS_TEAM_DOMAIN`, audience = `expectedAud`. Empty-string defense on email/sub. Returns lowercased email.
  - Test fixture (mcp-worker side): `mcp-worker/test/jwt-fixture.ts` — RSA keypair, JWKS injection via `_setJwksForTests`, signed-JWT minting with optional `aud` / `iss` overrides.
  - The mcp-worker file has an exported `_MODULE_ID = "mcp-worker/access-auth"` sentinel; the test asserts it in `beforeAll` to guard against vite resolving the import to the main worker's file via relative-path fallback.

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

- Owned by the **main worker** (writes via `migrations/`, reads via `src/users.js`). Distinct from `RF_MCP_CACHE` (sync-worker-owned) — the "only sync worker writes D1" invariant scopes to `RF_MCP_CACHE`.
- Schema: see [`migrations/0001_create_users.sql`](../migrations/0001_create_users.sql). `email TEXT PRIMARY KEY` with CHECK lowercase + LIKE `'%@%.%'`. UNIQUE indexes on `dialpad_id`, `rf_user_id`, `first_name`. CHECK constraint on `calendar_mode IN ('outlook', 'gcal', 'both')`.
- Seed: see [`migrations/0002_seed_users.sql`](../migrations/0002_seed_users.sql) (placeholder emails — substitute at apply-time).
- Module: [`src/users.js`](../src/users.js) — async, env-first, module-level cache (single bulk SELECT per Worker isolate, never invalidated within an isolate). Adding a teammate = a new migration applied via `wrangler d1 execute --remote`, then redeploy the workers (cold start refreshes the cache).

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

- **sync-worker cron is OFF** (disabled 2026-05-10) due to a D1 write-storm. Re-enable only after `writeJobs` / `writeJobPipeline` / `writeCandidatesAndLinks` gate on "is this row actually different from what's already there?". Not auth-related, but tracked here so a re-enable doesn't accidentally happen during auth work and surface as "weird unauthenticated traffic." The cron writes nothing through user-facing routes; it bypasses Access entirely.
