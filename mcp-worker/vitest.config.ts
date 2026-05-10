import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
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
          ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
          ACCESS_AUD_MCP: "a".repeat(64),
        },
      },
    }),
  ],
  test: {
    // The MCP SDK pulls in ajv (CJS, requires JSON) which the Workers
    // module-fallback loader can't handle directly. Pre-bundle via Vite SSR
    // optimizer so they reach the runtime as ESM with JSON inlined.
    // If a future test fails with a similar `SyntaxError: Unexpected token`
    // from another node_modules CJS dep, add that package to this list.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["ajv", "ajv-formats"],
        },
      },
    },
  },
});
