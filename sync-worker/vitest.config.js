import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.sync.jsonc' },
				// Required: workflow bindings are incompatible with isolatedStorage.
				// (vitest-pool-workers throws if both are set.) Tests share one D1
				// instance and rely on applyMigration() in beforeEach to reset state.
				isolatedStorage: false,
				miniflare: {
					bindings: {
						RF_API_KEY: 'test-rf-api-key',
						ADMIN_SECRET: 'test-admin-secret',
					},
				},
			},
		},
	},
});
