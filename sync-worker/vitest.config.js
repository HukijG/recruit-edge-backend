import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.sync.jsonc' },
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
