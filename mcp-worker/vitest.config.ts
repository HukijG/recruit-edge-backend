import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.mcp.jsonc" },
        miniflare: {
          // Override the MIDDLEWARE service binding with a no-op stub for tests.
          // Real binding only matters in deploy/dev; tests inject per-call mocks.
          serviceBindings: {
            MIDDLEWARE: () =>
              new Response(
                JSON.stringify({ ok: false, error: "test-stub: override env.MIDDLEWARE per test" }),
                { status: 503, headers: { "Content-Type": "application/json" } },
              ),
          },
          bindings: {
            MCP_EXTENSION_SECRET: "test-mcp-secret",
          },
        },
      },
    },
  },
});
