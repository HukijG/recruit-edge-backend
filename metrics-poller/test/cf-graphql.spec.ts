import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchCFMetrics } from '../src/cf-graphql.js';

const realFetch = globalThis.fetch;

const CONFIG = { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'account-id-xyz', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' };

// Real binding UUIDs from wrangler.jsonc — the poller maps them to friendly
// names so LD panels don't read as UUID soup.
const D1_STAGE_EVENTS_ID = '00000000-0000-0000-0000-000000000003';
const KV_SYNC_STATE_ID = 'REDACTED_KV_NAMESPACE_ID';

const ok = (data: any) =>
	new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });

const account = (fields: any) => ({ viewer: { accounts: [fields] } });

/**
 * Dispatch the per-dataset queries by their operation name. Unmapped datasets
 * answer with an empty account object.
 */
function mockGraphQL(byOperation: Record<string, any>) {
	const queries: string[] = [];
	globalThis.fetch = vi.fn(async (_url: any, init: any) => {
		const query: string = JSON.parse(init.body).query;
		queries.push(query);
		for (const [op, result] of Object.entries(byOperation)) {
			if (query.includes(`query ${op}`)) {
				return result instanceof Response ? result : ok(account(result));
			}
		}
		return ok(account({}));
	}) as any;
	return queries;
}

describe('fetchCFMetrics', () => {
	beforeEach(() => { globalThis.fetch = realFetch; });

	it('parses storage + AI results and maps binding ids to friendly names', async () => {
		mockGraphQL({
			StorageAndAI: {
				d1StorageAdaptiveGroups: [
					{ max: { databaseSizeBytes: 12345 }, dimensions: { databaseId: D1_STAGE_EVENTS_ID, date: '2026-06-11' } },
					{ max: { databaseSizeBytes: 777 }, dimensions: { databaseId: 'some-new-db-uuid', date: '2026-06-11' } },
				],
				kvStorageAdaptiveGroups: [
					{ max: { byteCount: 9876, keyCount: 42 }, dimensions: { namespaceId: KV_SYNC_STATE_ID, date: '2026-06-11' } },
				],
				aiInferenceAdaptiveGroups: [{
					count: 7,
					sum: { totalNeurons: 100, totalInferenceSteps: 12, totalInputTokens: 5000, totalOutputTokens: 800 },
					dimensions: { date: '2026-06-11' },
				}],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.d1Storage).toEqual([
			{ databaseName: 'rf-stage-events', sizeBytes: 12345 },
			{ databaseName: 'some-new-db-uuid', sizeBytes: 777 }, // unknown id falls through verbatim
		]);
		expect(result.kvStorage).toEqual([{ namespaceName: 'SYNC_STATE', byteCount: 9876, keyCount: 42 }]);
		expect(result.aiUsage).toEqual({
			neurons: 100, inferenceSteps: 12, inputTokens: 5000, outputTokens: 800, requests: 7,
		});
	});

	it('aggregates AI fields across multiple adaptive-group rows (per-day buckets)', async () => {
		mockGraphQL({
			StorageAndAI: {
				aiInferenceAdaptiveGroups: [
					{ count: 3, sum: { totalNeurons: 10, totalInferenceSteps: 4, totalInputTokens: 200, totalOutputTokens: 50 }, dimensions: { date: '2026-06-10' } },
					{ count: 5, sum: { totalNeurons: 25, totalInferenceSteps: 6, totalInputTokens: 800, totalOutputTokens: 150 }, dimensions: { date: '2026-06-11' } },
				],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.aiUsage).toEqual({
			neurons: 35, inferenceSteps: 10, inputTokens: 1000, outputTokens: 200, requests: 8,
		});
	});

	it('parses day-to-date D1 analytics per database (the billable rows-read/written counters)', async () => {
		mockGraphQL({
			D1Analytics: {
				d1AnalyticsAdaptiveGroups: [
					{ sum: { readQueries: 400, writeQueries: 50, rowsRead: 54_000, rowsWritten: 16_892 }, dimensions: { databaseId: D1_STAGE_EVENTS_ID, date: '2026-06-11' } },
					{ sum: { readQueries: 10, writeQueries: 1, rowsRead: 100, rowsWritten: 2 }, dimensions: { databaseId: D1_STAGE_EVENTS_ID, date: '2026-06-11' } },
				],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.d1Analytics).toEqual([
			{ databaseName: 'rf-stage-events', rowsRead: 54_100, rowsWritten: 16_894, readQueries: 410, writeQueries: 51 },
		]);
	});

	it('parses KV operations per namespace + action', async () => {
		mockGraphQL({
			KVOperations: {
				kvOperationsAdaptiveGroups: [
					{ sum: { requests: 1200 }, dimensions: { namespaceId: KV_SYNC_STATE_ID, actionType: 'read', date: '2026-06-11' } },
					{ sum: { requests: 90 }, dimensions: { namespaceId: KV_SYNC_STATE_ID, actionType: 'write', date: '2026-06-11' } },
				],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.kvOperations).toEqual([
			{ namespaceName: 'SYNC_STATE', actionType: 'read', requests: 1200 },
			{ namespaceName: 'SYNC_STATE', actionType: 'write', requests: 90 },
		]);
	});

	it('parses previous-hour Workers stats per script and inlines full-hour datetime bounds', async () => {
		const queries = mockGraphQL({
			WorkersHour: {
				workersInvocationsAdaptive: [
					{ sum: { requests: 320, errors: 2, subrequests: 4100 }, quantiles: { cpuTimeP50: 4200, cpuTimeP99: 91_000 }, dimensions: { scriptName: 'rf-dialpad-sync-dev' } },
				],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.workersHour).toEqual([
			{ scriptName: 'rf-dialpad-sync-dev', requests: 320, errors: 2, subrequests: 4100, cpuTimeP50Us: 4200, cpuTimeP99Us: 91_000 },
		]);
		const workersQuery = queries.find((q) => q.includes('query WorkersHour'))!;
		// Datetime literals are inlined (no undocumented scalar-type guessing)
		// and snapped to full-hour boundaries exactly one hour apart.
		const bounds = [...workersQuery.matchAll(/"(\d{4}-\d{2}-\d{2}T\d{2}:00:00Z)"/g)].map((m) => m[1]);
		expect(bounds).toHaveLength(2);
		expect(Date.parse(bounds[1]) - Date.parse(bounds[0])).toBe(3_600_000);
	});

	it('parses Durable Objects usage (requests + cpuTime summed, storedBytes maxed)', async () => {
		mockGraphQL({
			DOUsage: {
				durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 44 }, dimensions: { date: '2026-06-11' } }],
				durableObjectsPeriodicGroups: [{ sum: { cpuTime: 123_456 }, dimensions: { date: '2026-06-11' } }],
				durableObjectsStorageGroups: [
					{ max: { storedBytes: 2048 }, dimensions: { date: '2026-06-11' } },
					{ max: { storedBytes: 1024 }, dimensions: { date: '2026-06-10' } },
				],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.doUsage).toEqual({ requests: 44, cpuTimeUs: 123_456, storedBytes: 2048 });
	});

	it('parses day-to-date Workers totals and the month-to-date billing snapshot', async () => {
		const today = new Date().toISOString().slice(0, 10);
		mockGraphQL({
			WorkersDay: {
				workersInvocationsAdaptive: [
					{ sum: { requests: 5400, errors: 12, subrequests: 81_000 }, dimensions: { scriptName: 'rf-dialpad-sync-dev' } },
				],
			},
			WorkersMtd: {
				workersInvocationsAdaptive: [
					{ sum: { requests: 100_000 }, dimensions: { scriptName: 'rf-dialpad-sync-dev' } },
					{ sum: { requests: 23_456 }, dimensions: { scriptName: 'rf-music-remote' } },
				],
			},
			MonthToDate: {
				d1AnalyticsAdaptiveGroups: [
					{ sum: { rowsRead: 900_000, rowsWritten: 60_000 }, dimensions: { date: today } },
					{ sum: { rowsRead: 100_000, rowsWritten: 5_000 }, dimensions: { date: '2026-06-01' } },
				],
				kvOperationsAdaptiveGroups: [
					{ sum: { requests: 12_000 }, dimensions: { actionType: 'read', date: today } },
					{ sum: { requests: 300 }, dimensions: { actionType: 'write', date: today } },
				],
				durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 77 }, dimensions: { date: today } }],
				aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 45_000 }, dimensions: { date: today } }],
			},
			StorageAndAI: {
				aiInferenceAdaptiveGroups: [
					{ count: 2, sum: { totalNeurons: 999, totalInferenceSteps: 1, totalInputTokens: 1, totalOutputTokens: 1 }, dimensions: { date: '2026-06-10' } },
					{ count: 3, sum: { totalNeurons: 312, totalInferenceSteps: 1, totalInputTokens: 1, totalOutputTokens: 1 }, dimensions: { date: today } },
				],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.workersDay).toEqual([
			{ scriptName: 'rf-dialpad-sync-dev', requests: 5400, errors: 12, subrequests: 81_000 },
		]);
		expect(result.aiNeuronsToday).toBe(312); // today's slice only, not the 2-day sum
		const dim = (d: string) => result.billingMtd.find((b) => b.dimension === d)?.value;
		expect(dim('Workers requests (10M/mo incl)')).toBe(123_456); // summed across scripts
		expect(dim('D1 rows read (25B/mo incl)')).toBe(1_000_000); // summed across dates
		expect(dim('D1 rows written (50M/mo incl)')).toBe(65_000);
		expect(dim('KV reads (10M/mo incl)')).toBe(12_000);
		expect(dim('KV writes (1M/mo incl)')).toBe(300);
		expect(dim('DO requests (1M/mo incl)')).toBe(77);
		expect(dim('AI neurons MTD ($0.011/1k past 10k/day)')).toBe(45_000);
		expect(dim('AI neurons TODAY (10k/day free)')).toBe(312);
	});

	// Regression guard against CF schema drift. The original un-prefixed AI
	// field name broke when CF renamed it. Datasets are now isolated per
	// request, but the verified names still deserve a loud diff on change.
	it('uses the verified CF schema field names on aiInferenceAdaptiveGroups.sum', async () => {
		const queries = mockGraphQL({});
		await fetchCFMetrics(CONFIG);
		const aiQuery = queries.find((q) => q.includes('aiInferenceAdaptiveGroups'))!;
		expect(aiQuery).toContain('totalNeurons');
		expect(aiQuery).toContain('totalInferenceSteps');
		expect(aiQuery).toContain('totalInputTokens');
		expect(aiQuery).toContain('totalOutputTokens');
		// The plain un-prefixed name is the obsolete one. Absence is load-bearing —
		// its presence is what produced the production bug.
		const obsoleteFieldRegex = new RegExp('\\bsum\\s*\\{[^}]*\\b' + 'neur' + 'ons\\b');
		expect(aiQuery).not.toMatch(obsoleteFieldRegex);
	});

	it('uses correctly-capitalized GraphQL scalar types in every query', async () => {
		const queries = mockGraphQL({});
		await fetchCFMetrics(CONFIG);
		expect(queries.length).toBeGreaterThanOrEqual(5);
		for (const q of queries) {
			// GraphQL is case-sensitive on built-in scalars. Lowercase "string!"
			// would be rejected by the server.
			expect(q).toContain(': String!');
			expect(q).not.toMatch(/:\s+string!/);
		}
	});

	it('isolates dataset failures: one rejected query loses only its own metrics', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockGraphQL({
			// CF signals query-level failures as 200-OK-with-errors[].
			D1Analytics: new Response(JSON.stringify({
				data: null,
				errors: [{ message: 'unknown field "rowsRead"', path: null }],
			}), { headers: { 'content-type': 'application/json' } }),
			KVOperations: {
				kvOperationsAdaptiveGroups: [
					{ sum: { requests: 5 }, dimensions: { namespaceId: KV_SYNC_STATE_ID, actionType: 'read', date: '2026-06-11' } },
				],
			},
		});
		const result = await fetchCFMetrics(CONFIG);
		expect(result.d1Analytics).toEqual([]); // the failed dataset
		expect(result.kvOperations).toHaveLength(1); // the others still land
		const logged = errSpy.mock.calls.map((c) => c[0] as any);
		expect(logged.some((l) => l.message === 'GraphQL query errors' && l.dataset === 'd1-analytics')).toBe(true);
		errSpy.mockRestore();
	});

	it('returns safe empty results when every request 4xxes', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 })) as any;
		const result = await fetchCFMetrics(CONFIG);
		expect(result.d1Storage).toEqual([]);
		expect(result.kvStorage).toEqual([]);
		expect(result.aiUsage).toBeNull();
		expect(result.d1Analytics).toEqual([]);
		expect(result.kvOperations).toEqual([]);
		expect(result.workersHour).toEqual([]);
		expect(result.doUsage).toBeNull();
		errSpy.mockRestore();
	});
});
