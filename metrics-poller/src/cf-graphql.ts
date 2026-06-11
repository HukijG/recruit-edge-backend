export interface CFAIUsage {
	/** Neurons consumed (CF's billing unit). */
	neurons: number;
	/** Inference operations performed. */
	inferenceSteps: number;
	/** Input tokens consumed (LLM models). */
	inputTokens: number;
	/** Output tokens generated (LLM models). */
	outputTokens: number;
	/** Number of inference requests (top-level adaptive-groups `count`). */
	requests: number;
}

export interface CFD1Analytics {
	databaseName: string;
	rowsRead: number;
	rowsWritten: number;
	readQueries: number;
	writeQueries: number;
}

export interface CFKVOperations {
	namespaceName: string;
	actionType: string;
	requests: number;
}

export interface CFWorkersHour {
	scriptName: string;
	requests: number;
	errors: number;
	subrequests: number;
	cpuTimeP50Us: number;
	cpuTimeP99Us: number;
}

export interface CFDOUsage {
	requests: number;
	cpuTimeUs: number;
	storedBytes: number;
}

export interface CFBillingMtd {
	/** Human-readable billing dimension label, includes the Paid-plan quota. */
	dimension: string;
	value: number;
}

export interface CFMetricsResult {
	d1Storage: { databaseName: string; sizeBytes: number }[];
	kvStorage: { namespaceName: string; byteCount: number; keyCount: number }[];
	aiUsage: CFAIUsage | null;
	/** Workers AI neurons consumed TODAY (UTC) — the free tier is per-day. */
	aiNeuronsToday: number | null;
	/** Day-to-date (UTC) billable D1 query/row counts, per database. */
	d1Analytics: CFD1Analytics[];
	/** Day-to-date (UTC) billable KV operation counts, per namespace + action. */
	kvOperations: CFKVOperations[];
	/** Previous-hour per-script Workers invocation stats. */
	workersHour: CFWorkersHour[];
	/** Day-to-date (UTC) per-script Workers invocation totals. */
	workersDay: { scriptName: string; requests: number; errors: number; subrequests: number }[];
	/** Day-to-date (UTC) Durable Objects usage (account-wide). Null when the query failed. */
	doUsage: CFDOUsage | null;
	/**
	 * Month-to-date (UTC calendar month ≈ the billing period) account totals,
	 * one entry per billable dimension — the numbers the CF invoice is made
	 * of, labelled with their included quotas.
	 */
	billingMtd: CFBillingMtd[];
}

export interface CFGraphQLConfig {
	CF_API_TOKEN: string;
	CF_ACCOUNT_ID: string;
	CF_GRAPHQL_ENDPOINT: string;
}

/**
 * Single-tenant friendly-name maps so LD dashboards read `rf-stage-events`,
 * not a UUID. Sourced from wrangler.jsonc binding blocks (account has a
 * handful of resources; hardcoding is the project norm). Unknown ids fall
 * through verbatim so a new database/namespace is still visible — rename it
 * here when it appears.
 */
const D1_NAMES: Record<string, string> = {
	'00000000-0000-0000-0000-000000000001': 'rf-mcp-cache',
	'00000000-0000-0000-0000-000000000002': 'rf-users',
	'00000000-0000-0000-0000-000000000003': 'rf-stage-events',
};
const KV_NAMES: Record<string, string> = {
	'REDACTED_KV_NAMESPACE_ID': 'SYNC_STATE',
	'REDACTED_KV_PREVIEW_NAMESPACE_ID': 'SYNC_STATE (preview)',
};
const d1Name = (id: string) => D1_NAMES[id] ?? id;
const kvName = (id: string) => KV_NAMES[id] ?? id;

// Schema notes (2026-05-12, still load-bearing): the aggregated sum fields on
// `aiInferenceAdaptiveGroups` are prefixed `total*` (e.g. `totalNeurons`) —
// the un-prefixed names are rejected with `unknown field`. CF GraphQL rejects
// an ENTIRE query when any one field is unknown, which is why the datasets
// below are split into SEPARATE requests with per-request error isolation —
// one schema drift loses one dataset's metrics for a tick, not all of them
// (the original combined-query design lost D1+KV+AI together).
//
// To verify a field, introspect at https://cfdata.lol/graphql/ or POST
// `query Introspect { __type(name: "<TypeName>") { fields { name } } }`
// against https://api.cloudflare.com/client/v4/graphql with the poller token.
//
// Field provenance:
//  - d1AnalyticsAdaptiveGroups sum {readQueries writeQueries rowsRead rowsWritten}
//    + dims {date databaseId} — developers.cloudflare.com/d1/observability/metrics-analytics/
//  - kvOperationsAdaptiveGroups sum {requests} + dims {namespaceId actionType date}
//    — developers.cloudflare.com/kv/observability/metrics-analytics/
//  - workersInvocationsAdaptive sum {requests errors subrequests} +
//    quantiles {cpuTimeP50 cpuTimeP99} + dims {scriptName} —
//    developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
//  - durableObjectsInvocationsAdaptiveGroups sum {requests} /
//    durableObjectsPeriodicGroups sum {cpuTime} /
//    durableObjectsStorageGroups max {storedBytes} —
//    developers.cloudflare.com/durable-objects/observability/graphql-analytics/

const STORAGE_AI_QUERY = `
  query StorageAndAI($accountTag: String!, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1StorageAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
          orderBy: [date_DESC]
        ) {
          max { databaseSizeBytes }
          dimensions { databaseId date }
        }
        kvStorageAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
          orderBy: [date_DESC]
        ) {
          max { byteCount keyCount }
          dimensions { namespaceId date }
        }
        aiInferenceAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
        ) {
          count
          sum { totalNeurons totalInferenceSteps totalInputTokens totalOutputTokens }
          dimensions { date }
        }
      }
    }
  }
`;

const D1_ANALYTICS_QUERY = `
  query D1Analytics($accountTag: String!, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
        ) {
          sum { readQueries writeQueries rowsRead rowsWritten }
          dimensions { databaseId date }
        }
      }
    }
  }
`;

const KV_OPERATIONS_QUERY = `
  query KVOperations($accountTag: String!, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 500
        ) {
          sum { requests }
          dimensions { namespaceId actionType date }
        }
      }
    }
  }
`;

// Datetime bounds are inlined as ISO literals (server-generated, no user
// input) — the datetime scalar's GraphQL type name is undocumented, and a
// wrong variable type declaration would reject the query.
const workersHourQuery = (startIso: string, endIso: string) => `
  query WorkersHour($accountTag: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          filter: { datetime_geq: "${startIso}", datetime_leq: "${endIso}" }
          limit: 1000
        ) {
          sum { requests errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { scriptName }
        }
      }
    }
  }
`;

/** Same dataset, day-to-date window, per script — feeds the daily bar panels. */
const workersDayQuery = (startIso: string, endIso: string) => `
  query WorkersDay($accountTag: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          filter: { datetime_geq: "${startIso}", datetime_leq: "${endIso}" }
          limit: 1000
        ) {
          sum { requests errors subrequests }
          dimensions { scriptName }
        }
      }
    }
  }
`;

/** Month-to-date account total — feeds the billing snapshot table. */
const workersMtdQuery = (startIso: string, endIso: string) => `
  query WorkersMtd($accountTag: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          filter: { datetime_geq: "${startIso}", datetime_leq: "${endIso}" }
          limit: 1000
        ) {
          sum { requests }
          dimensions { scriptName }
        }
      }
    }
  }
`;

// Month-to-date totals for the date-granular datasets, summed client-side
// from per-date rows (all field names verified — see provenance above).
const MTD_QUERY = `
  query MonthToDate($accountTag: String!, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 500
        ) {
          sum { rowsRead rowsWritten }
          dimensions { date }
        }
        kvOperationsAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 500
        ) {
          sum { requests }
          dimensions { actionType date }
        }
        durableObjectsInvocationsAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
        ) {
          sum { requests }
          dimensions { date }
        }
        aiInferenceAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
        ) {
          sum { totalNeurons }
          dimensions { date }
        }
      }
    }
  }
`;

const DO_USAGE_QUERY = `
  query DOUsage($accountTag: String!, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        durableObjectsInvocationsAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
        ) {
          sum { requests }
          dimensions { date }
        }
        durableObjectsPeriodicGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
        ) {
          sum { cpuTime }
          dimensions { date }
        }
        durableObjectsStorageGroups(
          filter: { date_geq: $start, date_leq: $end }
          limit: 100
        ) {
          max { storedBytes }
          dimensions { date }
        }
      }
    }
  }
`;

/**
 * Run one GraphQL query with full error isolation: network throw, HTTP
 * non-2xx, and CF's 200-OK-with-errors[] all log a structured error tagged
 * with the dataset label and return null — the other datasets' metrics still
 * emit this tick.
 */
async function runQuery(
	config: CFGraphQLConfig,
	label: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<any | null> {
	let response: Response;
	try {
		response = await fetch(config.CF_GRAPHQL_ENDPOINT, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${config.CF_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ query, variables }),
		});
	} catch (err) {
		console.error({ source: 'metrics-poller', message: 'GraphQL fetch failed', dataset: label, error: String(err) });
		return null;
	}
	if (!response.ok) {
		console.error({ source: 'metrics-poller', message: 'GraphQL HTTP error', dataset: label, status: response.status });
		return null;
	}
	const json = await response.json() as any;
	// CF GraphQL returns 200 OK with `{data: null, errors: [...]}` for query
	// errors (e.g. unknown field). Surface loudly so the next schema drift is
	// visible in logs instead of producing empty dataPoints.
	if (Array.isArray(json?.errors) && json.errors.length > 0) {
		console.error({
			source: 'metrics-poller',
			message: 'GraphQL query errors',
			dataset: label,
			errors: json.errors.map((e: any) => e?.message ?? String(e)),
		});
		return null;
	}
	return json?.data?.viewer?.accounts?.[0] || {};
}

export async function fetchCFMetrics(config: CFGraphQLConfig): Promise<CFMetricsResult> {
	const now = Date.now();
	const today = new Date(now).toISOString().slice(0, 10);
	const yesterday = new Date(now - 24 * 3600 * 1000).toISOString().slice(0, 10);
	// Previous full hour for the datetime-granular Workers dataset.
	const hourEnd = new Date(Math.floor(now / 3_600_000) * 3_600_000);
	const hourStart = new Date(hourEnd.getTime() - 3_600_000);
	const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

	const dayStart = `${today}T00:00:00Z`;
	const monthStart = `${today.slice(0, 8)}01`;

	const accountTag = config.CF_ACCOUNT_ID;
	const [storageAi, d1An, kvOps, workers, doUsage, workersDayRes, workersMtdRes, mtd] = await Promise.all([
		runQuery(config, 'storage+ai', STORAGE_AI_QUERY, { accountTag, start: yesterday, end: today }),
		runQuery(config, 'd1-analytics', D1_ANALYTICS_QUERY, { accountTag, start: today, end: today }),
		runQuery(config, 'kv-operations', KV_OPERATIONS_QUERY, { accountTag, start: today, end: today }),
		runQuery(config, 'workers-invocations', workersHourQuery(isoSeconds(hourStart), isoSeconds(hourEnd)), { accountTag }),
		runQuery(config, 'durable-objects', DO_USAGE_QUERY, { accountTag, start: today, end: today }),
		runQuery(config, 'workers-day', workersDayQuery(dayStart, isoSeconds(new Date(now))), { accountTag }),
		runQuery(config, 'workers-mtd', workersMtdQuery(`${monthStart}T00:00:00Z`, isoSeconds(new Date(now))), { accountTag }),
		runQuery(config, 'month-to-date', MTD_QUERY, { accountTag, start: monthStart, end: today }),
	]);

	const d1Storage = ((storageAi?.d1StorageAdaptiveGroups as any[]) || []).map((row: any) => ({
		databaseName: d1Name(row.dimensions.databaseId),
		sizeBytes: row.max?.databaseSizeBytes ?? 0,
	}));
	const kvStorage = ((storageAi?.kvStorageAdaptiveGroups as any[]) || []).map((row: any) => ({
		namespaceName: kvName(row.dimensions.namespaceId),
		byteCount: row.max?.byteCount ?? 0,
		keyCount: row.max?.keyCount ?? 0,
	}));
	const aiGroups = (storageAi?.aiInferenceAdaptiveGroups as any[]) || [];
	const aiUsage: CFAIUsage | null = aiGroups.length > 0
		? aiGroups.reduce(
			(acc: CFAIUsage, g: any) => ({
				neurons: acc.neurons + (g.sum?.totalNeurons ?? 0),
				inferenceSteps: acc.inferenceSteps + (g.sum?.totalInferenceSteps ?? 0),
				inputTokens: acc.inputTokens + (g.sum?.totalInputTokens ?? 0),
				outputTokens: acc.outputTokens + (g.sum?.totalOutputTokens ?? 0),
				requests: acc.requests + (g.count ?? 0),
			}),
			{ neurons: 0, inferenceSteps: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
		)
		: null;

	// Day-to-date per database (one UTC date in the window; sum defensively in
	// case CF returns multiple rows per database).
	const d1ByDb = new Map<string, CFD1Analytics>();
	for (const row of (d1An?.d1AnalyticsAdaptiveGroups as any[]) || []) {
		const name = d1Name(row.dimensions?.databaseId ?? 'unknown');
		const entry = d1ByDb.get(name) ?? { databaseName: name, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
		entry.rowsRead += row.sum?.rowsRead ?? 0;
		entry.rowsWritten += row.sum?.rowsWritten ?? 0;
		entry.readQueries += row.sum?.readQueries ?? 0;
		entry.writeQueries += row.sum?.writeQueries ?? 0;
		d1ByDb.set(name, entry);
	}

	const kvByKey = new Map<string, CFKVOperations>();
	for (const row of (kvOps?.kvOperationsAdaptiveGroups as any[]) || []) {
		const name = kvName(row.dimensions?.namespaceId ?? 'unknown');
		const actionType = row.dimensions?.actionType ?? 'unknown';
		const key = `${name}:${actionType}`;
		const entry = kvByKey.get(key) ?? { namespaceName: name, actionType, requests: 0 };
		entry.requests += row.sum?.requests ?? 0;
		kvByKey.set(key, entry);
	}

	const workersHour: CFWorkersHour[] = ((workers?.workersInvocationsAdaptive as any[]) || []).map((row: any) => ({
		scriptName: row.dimensions?.scriptName ?? 'unknown',
		requests: row.sum?.requests ?? 0,
		errors: row.sum?.errors ?? 0,
		subrequests: row.sum?.subrequests ?? 0,
		cpuTimeP50Us: row.quantiles?.cpuTimeP50 ?? 0,
		cpuTimeP99Us: row.quantiles?.cpuTimeP99 ?? 0,
	}));

	let doResult: CFDOUsage | null = null;
	if (doUsage) {
		const reqRows = (doUsage.durableObjectsInvocationsAdaptiveGroups as any[]) || [];
		const periodicRows = (doUsage.durableObjectsPeriodicGroups as any[]) || [];
		const storageRows = (doUsage.durableObjectsStorageGroups as any[]) || [];
		doResult = {
			requests: reqRows.reduce((n: number, r: any) => n + (r.sum?.requests ?? 0), 0),
			cpuTimeUs: periodicRows.reduce((n: number, r: any) => n + (r.sum?.cpuTime ?? 0), 0),
			storedBytes: storageRows.reduce((m: number, r: any) => Math.max(m, r.max?.storedBytes ?? 0), 0),
		};
	}

	// The free AI tier is PER DAY — surface today's slice of the per-date
	// groups the storage+ai query already returns.
	const aiNeuronsToday = aiGroups.length > 0
		? aiGroups
			.filter((g: any) => g.dimensions?.date === today)
			.reduce((n: number, g: any) => n + (g.sum?.totalNeurons ?? 0), 0)
		: null;

	const workersDay = ((workersDayRes?.workersInvocationsAdaptive as any[]) || []).map((row: any) => ({
		scriptName: row.dimensions?.scriptName ?? 'unknown',
		requests: row.sum?.requests ?? 0,
		errors: row.sum?.errors ?? 0,
		subrequests: row.sum?.subrequests ?? 0,
	}));

	// The billing snapshot: month-to-date account totals per billable
	// dimension, quota in the label so the dashboard table is self-describing.
	const billingMtd: CFBillingMtd[] = [];
	const sumRows = (rows: any[] | undefined, pick: (r: any) => number) =>
		(rows || []).reduce((n: number, r: any) => n + pick(r), 0);
	if (workersMtdRes) {
		billingMtd.push({
			dimension: 'Workers requests (10M/mo incl)',
			value: sumRows(workersMtdRes.workersInvocationsAdaptive as any[], (r) => r.sum?.requests ?? 0),
		});
	}
	if (mtd) {
		billingMtd.push(
			{ dimension: 'D1 rows read (25B/mo incl)', value: sumRows(mtd.d1AnalyticsAdaptiveGroups as any[], (r) => r.sum?.rowsRead ?? 0) },
			{ dimension: 'D1 rows written (50M/mo incl)', value: sumRows(mtd.d1AnalyticsAdaptiveGroups as any[], (r) => r.sum?.rowsWritten ?? 0) },
			{ dimension: 'DO requests (1M/mo incl)', value: sumRows(mtd.durableObjectsInvocationsAdaptiveGroups as any[], (r) => r.sum?.requests ?? 0) },
			{ dimension: 'AI neurons MTD ($0.011/1k past 10k/day)', value: sumRows(mtd.aiInferenceAdaptiveGroups as any[], (r) => r.sum?.totalNeurons ?? 0) },
		);
		const KV_QUOTA: Record<string, string> = {
			read: 'KV reads (10M/mo incl)',
			write: 'KV writes (1M/mo incl)',
			delete: 'KV deletes (1M/mo incl)',
			list: 'KV lists (1M/mo incl)',
		};
		const kvTotals = new Map<string, number>();
		for (const row of (mtd.kvOperationsAdaptiveGroups as any[]) || []) {
			const action = row.dimensions?.actionType ?? 'unknown';
			kvTotals.set(action, (kvTotals.get(action) ?? 0) + (row.sum?.requests ?? 0));
		}
		for (const [action, value] of kvTotals) {
			billingMtd.push({ dimension: KV_QUOTA[action] ?? `KV ${action} ops`, value });
		}
	}
	if (aiNeuronsToday !== null) {
		billingMtd.push({ dimension: 'AI neurons TODAY (10k/day free)', value: aiNeuronsToday });
	}

	return {
		d1Storage,
		kvStorage,
		aiUsage,
		aiNeuronsToday,
		d1Analytics: [...d1ByDb.values()],
		kvOperations: [...kvByKey.values()],
		workersHour,
		workersDay,
		doUsage: doResult,
		billingMtd,
	};
}
