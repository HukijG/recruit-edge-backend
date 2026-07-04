# cache-worker — D1-backed cache worker

A sibling Cloudflare Worker (own install root: `package.json`, `wrangler*.jsonc`,
`src/`, `test/`, `migrations/`) that backs the main worker's read cache.

**Status: in use, with one pending cutover step.** The "thin-immutable cache"
migration is partially complete — earlier steps shipped; the final legacy-drop step
is intentionally still pending while dual-write code is removed. Because of that:

- `migrations/` holds the applied schema migrations.
- `migrations-pending/0004_drop_legacy.sql` is **deliberately staged outside** the
  applied-migrations directory and must not be run until the dual-write path is gone.

For the cutover rationale and current step status, see the top-level
[`../docs/architecture.md`](../docs/architecture.md).
