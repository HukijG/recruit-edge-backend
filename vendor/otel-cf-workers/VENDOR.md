# `@microlabs/otel-cf-workers` — vendored fork

Source: <https://github.com/evanderkoogh/otel-cf-workers> at tag `v1.0.0-rc.52` (commit `76fb3b2` upstream).

Forked on 2026-05-11 into `vendor/otel-cf-workers/`. The upstream `.git` was removed entirely on import — this directory is fully owned by the parent repo and is not synced from upstream. Treat it as first-party code: edit the TypeScript source under `src/`, rebuild with `npm run build:src`, commit the resulting `dist/` changes.

## Why forked

`@microlabs/otel-cf-workers` is the only mature OpenTelemetry substrate for Cloudflare Workers, but the upstream has had a ~12-month release gap. The published `1.0.0-rc.52` build ships two defects that affect us:

1. **`postProcessor` config is declared in `TraceConfig` types + README but never invoked.** `dist/index.js` parses `supplied.postProcessor` into the resolved config (with a no-op default) and then nothing — no call site anywhere in the published build. Without intervention this means `launchdarkly.project_id` resource enrichment doesn't reach exported spans, and the entire trace-side LD auth path silently breaks.

2. **`WorkerTracer.addToResource(extra)`** calls `this.resource.merge(extra)` but discards the return value. `Resource.merge()` is non-mutating in OTel v2, so this method is also dead code. Less impact than the postProcessor bug but flagged here to spare anyone discovering it twice.

Owning the source means we can fix both, and we can roll forward when we hit the next skeleton.

## How to edit

Source lives under `vendor/otel-cf-workers/src/*.ts`. Build output lives under `vendor/otel-cf-workers/dist/`.

To rebuild after editing source:

```bash
cd vendor/otel-cf-workers
npm run build:src
```

This runs `tsup` (configured in `tsup.config.ts`) which produces `dist/index.js`, `dist/index.mjs`, and `dist/index.d.ts`. The build output is committed alongside the source — `dist/` is **not** in `.gitignore` for this directory (see root `.gitignore` for the un-ignore rule).

`versions.json` (used at runtime for telemetry SDK version attributes) is a static committed file; bump it manually if you change the fork's effective version.

## What we patched

- **`src/spanprocessor.ts`** — `TraceState.exportSpans()` now reads the active `ResolvedTraceConfig` via `getActiveConfig()` and applies `config.postProcessor(spans)` before forwarding to the exporter. See commit `fix(vendor/otel-cf-workers): invoke postProcessor in BatchTraceSpanProcessor` for the diff.

## What we removed from the import

- `.git/`, `.github/`, `.husky/`, `.changeset/`, `.vscode/` — all upstream-development tooling, irrelevant for consumers.
- `.gitignore`, `.gitattributes`, `.npmignore`, `.prettierignore`, `.prettierrc`, `.editorconfig` — vendor-internal config that conflicts with or duplicates parent-repo conventions.
- `pnpm-lock.yaml` — upstream uses pnpm; we use npm (the package is part of our root npm workspace, so the root `package-lock.json` is authoritative).
- `package.json` `prepare: husky` script — would fail at install time without the `.husky/` directory.

## Workspace wiring

Declared as an npm workspace in the root `package.json`:

```jsonc
"workspaces": ["cache-worker", "mcp-remote", "vendor/otel-cf-workers"]
```

Workers' `package.json` files keep their `"@microlabs/otel-cf-workers": "1.0.0-rc.52"` dependency declaration unchanged. npm resolves the name to this workspace (the version in `vendor/otel-cf-workers/package.json` matches the dep range), symlinks it into the shared root `node_modules/`, and esbuild/wrangler bundling resolves through that symlink.

## Upstream re-sync

We do **not** track upstream. If a future upstream release is worth pulling in:

1. Diff our `src/` against the upstream tag's source to identify our patches.
2. Pull the new upstream into `/tmp/`, strip `.git/`/`.github/`/etc.
3. Re-apply our patches (or carefully re-baseline by replacing the source then re-applying the diffs).
4. Rebuild `dist/`, run all three worker test suites, commit.

The reverse — sending our fixes upstream — should be considered for the postProcessor patch specifically. It's a clear bug, the fix is small, and the maintainer might accept the PR. If sent upstream and merged, future re-syncs become merge-fast-forwards.

<!-- ci-trigger: 2026-05-12 -->
