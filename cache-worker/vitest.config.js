import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.cache.jsonc' },
			// Required: workflow bindings are incompatible with isolatedStorage.
			// (vitest-pool-workers throws if both are set.) Tests share one D1
			// instance and rely on applyMigration() in beforeEach to reset state.
			isolatedStorage: false,
			// Force sequential execution. With isolatedStorage off, parallel
			// test files race on `applyMigration`'s DROP/CREATE cycle and
			// produce flaky "table already exists" / "no such table" errors.
			// Running all files in one worker, in series, eliminates the race.
			singleWorker: true,
			miniflare: {
				bindings: {
					RF_API_KEY: 'test-rf-api-key',
					ADMIN_SECRET: 'test-admin-secret',
					INTERNAL_SECRET: 'test-internal-secret',
					DIALPAD_API_KEY: 'test-dialpad-api-key',
				},
			},
		}),
	],
});
