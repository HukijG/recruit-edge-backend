# mcp-remote (`rf-mcp-remote`)

Public Streamable-HTTP MCP server consumed by claude.ai. Stateless TypeScript Worker; validates the Cloudflare Access JWT, then service-binds into the main worker's `/mcp/*` API.

Architecture, auth shape, and full middleware semantics live in:
- [`../docs/architecture.md`](../docs/architecture.md) — system overview, service-binding flow
- [`../docs/security.md`](../docs/security.md) — Cloudflare Access OAuth + JWT validation
- [`../docs/mcp-middleware.md`](../docs/mcp-middleware.md) — tool descriptors, entity resolvers, response shapes

## Setup — install dependencies independently from the root

`mcp-remote` is an isolated subtree with its own `package.json`. Dependencies must be installed locally to this directory — do not rely on the root project's `node_modules`.

The pinned versions of `@cloudflare/vitest-pool-workers` differ between the two workspaces:

| Workspace | Pinned version |
|---|---|
| root (`/package.json`) | `^0.8.19` |
| `mcp-remote/package.json` | `^0.16.3` |

Without local `node_modules` in `mcp-remote/`, Node's module resolution will fall through to the root install and surface a misleading `cloudflareTest` export error (the older root version doesn't expose the same testing surface).

**Run from inside `mcp-remote/`:**

```bash
cd mcp-remote
npm install
npm test
```

After the first `npm install`, subsequent `npm test` runs in this directory work normally. If you ever see a `cloudflareTest` / pool-workers export error, the symptom is the resolver climbing to the root — re-run `npm install` inside `mcp-remote/` to fix.

## Scripts

- `npm run dev` — `wrangler dev --config wrangler.mcp.jsonc`
- `npm run deploy` — `wrangler deploy --config wrangler.mcp.jsonc`
- `npm test` — `vitest run`

Deployment is automatic on push to `master` via GitHub (the same Action that deploys the main worker — the watch path is set per worker so this subtree deploys independently).
