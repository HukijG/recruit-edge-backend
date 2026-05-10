# OAuth — current state, requirements, open questions

> **Status: SPECULATIVE — UNRESEARCHED.** Nothing in this document represents a decision, plan, or commitment. It captures (a) why OAuth came onto the table, (b) what auth looks like *today* across the workers and the extension, and (c) the questions that need answering before any actual design work begins. Everything below the "Current state" section is open: do not implement against any of it without a real spec.

## What surfaced this

claude.ai's custom-MCP-connector UI accepts only an `OAuth client_id` + `OAuth client_secret` pair — no field for arbitrary HTTP headers. The `rf-mcp-remote` worker as deployed today expects two custom headers (`X-MCP-Token`, `X-RF-Consultant`); that contract is fine for `mcp inspector` and `curl`, but it does not work as a claude.ai custom connector. To use rf-mcp-remote from claude.ai for everyone on the team, the worker has to speak OAuth.

## Current state (what actually exists today)

### Auth surfaces

| Worker / consumer | Auth mechanism | Identity carrier |
|---|---|---|
| `rf-dialpad-sync-dev` `/mcp/*` | `X-MCP-Token` header (single shared secret: `MCP_EXTENSION_SECRET`) | `consultantFirstName` field in body, resolved against `src/users.js` via `getUserByFirstName` → 403 if unknown |
| `rf-dialpad-sync-dev` extension routes (`/candidates`, `/dialpad-hangup`, `/job-pipeline`, etc.) | `X-Extension-Token` header (single shared secret) | `consultantFirstName` body field, same `users.js` lookup |
| `rf-dialpad-sync-dev` Dialpad webhooks (`/webhook/dialpad/*`) | JWT signature (HS256 via `jose` in `src/auth.js`) | Dialpad sends `target.id` / `contact.id`; `getUserByDialpadId` maps to RF id |
| `rf-dialpad-sync-dev` RF webhook (`/webhook/recruiterflow`) | (RF doesn't sign — relies on URL secrecy) | RF event payload |
| `rf-mcp-remote` `/mcp` | `X-MCP-Token` constant-time compare; `X-RF-Consultant` presence check, forwarded as `consultantFirstName` body field to the middleware | Same as middleware path |

### Identity registry

`src/users.js` is a hardcoded `USERS` array of `{ firstName, rfUserId, dialpadId }` records. Adding a teammate is a one-file edit. Every consultant lookup (cold-call attribution, calendar Joel-only logic, Apollo Joel-only enrichment, extension `consultantFirstName` resolution, MCP `consultantFirstName` resolution) reads from it. There is no per-user secret, no per-user token, no per-user OAuth identity. Everyone with the shared secret can claim any `consultantFirstName` value.

### Trust model implications

- One leak of `MCP_EXTENSION_SECRET` or `X-Extension-Token` compromises the whole surface for that secret. There is no rotation story per consultant.
- No per-user audit trail at the auth layer — `consultantFirstName` in the body is an attribution claim, not an authentication.
- Adding/removing teammates requires a code edit + push. No self-serve.
- Acceptable today because the user count is ~5 and the team trusts each other's machines.

## Why OAuth, and what changes if it lands

Two distinct forcing functions, both hitting around the same time:

1. **claude.ai custom connector** requires OAuth (already covered above).
2. **The extension** is currently bearer-secret + claimed-name. Joel has stated intent to put the extension behind OAuth as well, eventually. Doing this once for both consumers (and any future Worker that joins this stack) is preferable to doing it twice.

If both consumers spoke the same OAuth flow against the same identity provider, then:

- `users.js` could be retired (or reduced to a side-table mapping OAuth identity → RF user id, kept only because `rfUserId` is RF-specific and OAuth IdPs don't know about it).
- Per-user accountability becomes real (audit logs, revocation, rotation).
- New teammates onboard via "log in with X," not a code change.

## What we'd need (requirements, not a design)

Listed only to bound the unknowns — none of these are answered.

- **Identity provider.** Cloudflare Access? Workers OAuth Provider (`@cloudflare/workers-oauth-provider`)? Auth0? Google Workspace OIDC? GitHub OAuth? Each has different ergonomics for the extension side vs the MCP side.
- **Where the OAuth surface lives.** A single dedicated worker that does the OAuth dance and issues short-lived tokens others verify? Cloudflare Access in front of multiple workers? A shared library imported by each worker?
- **Token shape between workers.** If `rf-dialpad-sync-dev` (middleware) trusts the OAuth-fronted callers, what does the inbound credential look like? JWT it can verify locally? Service-binding-passed claims? An identity header set by an upstream OAuth proxy?
- **Mapping OAuth identity → RF user id.** OAuth tells us "this is joel@cognatio.test," but RF needs `rfUserId: 900005`. Where does that mapping live (KV, D1, hardcoded continuation of users.js)? Who maintains it? Is it self-bootstrapping (first login claims the id) or admin-curated?
- **Extension UX.** The Chrome extension presumably needs an OAuth login flow inside it — popup? options page? device-code? — and a token-refresh story. Today's "shared secret typed once into config" is replaced by something the user has to actually log in to.
- **MCP UX.** claude.ai handles the OAuth dance for connectors itself, given the right `client_id` / `client_secret` / `authorization_endpoint` / `token_endpoint`. We have to expose those endpoints — either by building them in a Worker or by sitting behind a managed IdP that exposes them.
- **Backwards-compatible cutover.** The Dialpad and RF webhooks aren't user-driven — they have their own auth (JWT for Dialpad, URL secret for RF). Those don't go through OAuth. So the answer is mixed-mode: OAuth for human-driven traffic, current schemes for machine webhooks. The boundary needs to be drawn explicitly.
- **Where this lives in the monorepo.** A new `auth-worker/` sibling? A new `src/oauth/` module on the middleware? A separate repo? "Centralized so any future worker can use it" implies the first option, but that's not yet decided.

## What we have to do (in order, all TBD)

None of the steps below are committed; they are the *shape of the work*, not a plan.

1. **Pick the IdP and the deployment shape.** This is the load-bearing decision; everything else falls out of it. Probably a brainstorming spec.
2. **Decide the inbound credential format** that workers verify (and whether one shared verification utility lives somewhere shared).
3. **Decide the OAuth identity → RF user id mapping** — schema + ownership.
4. **Build the OAuth provider surface** (whatever shape Step 1 chose).
5. **Migrate `rf-mcp-remote`** off `X-MCP-Token` + `X-RF-Consultant` onto OAuth-issued credentials. Re-add it as a claude.ai connector with OAuth fields.
6. **Migrate the extension** off `X-Extension-Token` + `consultantFirstName`-in-body onto OAuth. Update the extension's storage / UI for the login flow.
7. **Retire (or reduce) `src/users.js`** once no consumer is keying off `firstName` for auth.
8. **Document the new model** and replace this file with the actual design + spec.

## Out of scope of any future OAuth work (probably)

- Dialpad webhook auth — stays JWT. Not user-driven.
- RF webhook auth — stays URL-secret. Not user-driven, and we can't change RF.
- Worker-to-worker service bindings — stay binding-name-as-trust. They never leave the account boundary.
- Per-tool / per-route ACLs. Today every authenticated user can call every endpoint; OAuth gives us the *capability* to add per-user permissions later but doing so isn't part of "ship OAuth."

## When this doc is wrong

It will be, quickly. The moment someone runs the brainstorming session for Step 1, this doc should be replaced (or heavily revised) by the resulting spec. Until then, treat the contents as honest about what exists today and openly speculative about what comes next.
