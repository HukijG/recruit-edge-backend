import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// Main worker tests only. The sync-worker has its own vitest.config.js
		// and its own bindings; running from sync-worker/ via `npm test` there.
		include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
		exclude: ['sync-worker/**', 'node_modules/**'],
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
						MCP_EXTENSION_SECRET: 'test-mcp-extension-secret',
						ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
						ACCESS_AUD_MCP: 'test-aud-mcp-64hex',
					},
					d1Databases: {
						RF_MCP_CACHE: 'rf-mcp-cache-test',
						USERS_DB: 'rf-users-test',
					},
				},
			},
		},
	},
});
