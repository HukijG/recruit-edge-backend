import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// Main worker tests only. The cache-worker has its own vitest.config.js
		// and its own bindings; running from cache-worker/ via `npm test` there.
		include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
		exclude: ['cache-worker/**', 'node_modules/**'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						LINKEDIN_EXTENSION_SECRET: 'test-extension-secret',
						RF_API_KEY: 'test-rf-api-key',
						DIALPAD_API_KEY: 'test-dialpad-api-key',
						APOLLO_API_KEY: 'test-apollo-api-key',
						DIALPAD_WEBHOOK_SECRET: 'test-dialpad-webhook-secret',
						CALENDAR_WEBHOOK_SECRET: 'test-calendar-webhook-secret',
						RF_WEBHOOK_SECRET: 'test-rf-webhook-secret',
						KRISP_WEBHOOK_SECRET: 'test-krisp-webhook-secret',
						APOLLO_WEBHOOK_SECRET: 'test-apollo-webhook-secret',
						ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
						ACCESS_AUD_MCP: 'a'.repeat(64),  // 64-char hex shape matches production Access AUD format (App 1 / MCP)
						// SaaS-OIDC App 2 tokens carry the redirect URI as the aud claim (not the client_id, not an AUD tag).
						// Comma-separated to exercise the multi-redirect-URI path.
						ACCESS_AUD_MIDDLEWARE:
							'https://test-ext-primary.chromiumapp.org/oauth-callback,https://test-ext-secondary.chromiumapp.org/oauth-callback',
						ACCESS_CLIENT_ID_MIDDLEWARE: 'c'.repeat(64),  // 64-char hex shape matches production SaaS-OIDC client_id
						INTERNAL_SECRET: 'test-internal-secret',
						// LD_SDK_KEY intentionally omitted — its absence is the signal that src/index.js uses
						// to skip the @microlabs `instrument()` wrap (and logs-bridge to skip its install). In
						// production, the secret is set, so instrument() + logs-bridge are active. Setting it
						// here would force the OTLP exporters to fire on every test request, polluting tests
						// that count globalThis.fetch invocations and breaking strict-zero-calls assertions.
					},
					d1Databases: {
						RF_MCP_CACHE: 'rf-mcp-cache-test',
						USERS_DB: 'rf-users-test',
					},
					// Mock the SYNC_WORKER service binding so miniflare starts cleanly.
					// Tests that need to assert on forwarded requests inject their own
					// vi.fn() via a spread of env — this stub just prevents the runtime
					// startup failure from an unresolved service name.
					serviceBindings: {
						SYNC_WORKER: async () => new Response('{"ok":true}', { status: 200 }),
					},
				},
			},
		},
	},
});
