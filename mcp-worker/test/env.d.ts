import type { Env as WorkerEnv } from "../src/index.js";

// vitest-pool-workers v0.16+ types `cloudflare:test`'s `env` as `Cloudflare.Env`
// (a global namespace), not the old `ProvidedEnv` interface inside the
// `cloudflare:test` module. Augment the global so tests pass `env` to
// worker.fetch(req, env, ctx) without TS complaining about missing bindings.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
