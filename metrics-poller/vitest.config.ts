import { defineConfig } from 'vitest/config';

// metrics-poller tests are pure unit tests (no Workers bindings, no DO state).
// Use the default Node pool — keeps tests fast and avoids dragging in
// @cloudflare/vitest-pool-workers from the root config.
export default defineConfig({
	test: {
		include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
		// Prevent vitest from walking up to the workspace-root vitest.config.js
		// (which forces the @cloudflare/vitest-pool-workers runner). This file
		// IS the root for metrics-poller's test runs.
		root: '.',
	},
});
