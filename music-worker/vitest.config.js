import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// NOTE on the config shape: the only @cloudflare/vitest-pool-workers physically
// installed in this tree is 0.8.71 (root-hoisted), which exposes
// `defineWorkersConfig`/`defineWorkersProject` via `./config` and does NOT export
// the `cloudflareTest` plugin that cache-worker/ + mcp-remote/ use (those pin
// ^0.16.3, which is not materialised here). So this worker uses the MAIN worker's
// `defineWorkersConfig` + `test.poolOptions.workers` shape, which resolves against
// 0.8.71. package.json pins ^0.8.71 to match. This is a deliberate
// implementation-reality call, not blind-mirroring of a sibling that doesn't run
// in this tree.
export default defineWorkersConfig({
	test: {
		include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.music.jsonc' },
				// isolatedStorage MUST be false here. The DO holds LONG-LIVED
				// hibernatable WebSockets (the now-playing fan-out sockets) that
				// stay open past the end of the test that opened them. With
				// isolatedStorage:true, vitest-pool-workers tries to pop the DO's
				// storage stack frame after each test and asserts on a clean
				// .sqlite handle — an open WebSocket keeps that frame live and the
				// pop fails ("Failed to pop isolated storage stack frame ... unable
				// to pop Durable Objects storage"). Each DO test already addresses a
				// UNIQUE idFromName, so there is no cross-test state bleed to
				// isolate. (cache-worker also runs isolatedStorage:false, for a
				// different — Workflows — incompatibility.)
				isolatedStorage: false,
				// Run all files in one worker, in series. With isolatedStorage off,
				// this keeps the single shared runtime deterministic.
				singleWorker: true,
				miniflare: {
					bindings: {
						// Legacy extension shared secret (X-Extension-Token path).
						LINKEDIN_EXTENSION_SECRET: 'test-extension-secret',
						// Cloudflare Access team domain.
						ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
						// App-2 (SaaS-OIDC) audience set. SaaS-OIDC access_tokens carry
						// the registered redirect URI as the aud claim. Comma-separated
						// to exercise the multi-redirect-URI path (mirrors the root
						// vitest.config.js multi-value shape).
						ACCESS_AUD_MIDDLEWARE:
							'https://test-ext-primary.chromiumapp.org/oauth-callback,https://test-ext-secondary.chromiumapp.org/oauth-callback',
						// App-2 SaaS-OIDC client_id (64-char hex shape).
						ACCESS_CLIENT_ID_MIDDLEWARE: 'c'.repeat(64),
						// Outbound dashboard proxy.
						DASHBOARD_REMOTE_KEY: 'test-remote-key',
						DASHBOARD_REMOTE_BASE: 'https://dashboard.test.local',
					},
					d1Databases: {
						// Read-only USERS_DB binding — identity gate source of truth.
						USERS_DB: 'rf-users-test',
					},
				},
			},
		},
	},
});
