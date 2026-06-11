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

export interface CFMetricsResult {
	d1Storage: { databaseName: string; sizeBytes: number }[];
	kvStorage: { namespaceName: string; byteCount: number; keyCount: number }[];
	aiUsage: CFAIUsage | null;
	/** Day-to-date (UTC) billable D1 query/row counts, per database. */
	d1Analytics: CFD1Analytics[];
	/** Day-to-date (UTC) billable KV operation counts, per namespace + action. */
	kvOperations: CFKVOperations[];
	/** Previous-hour per-script Workers invocation stats. */
	workersHour: CFWorkersHour[];
	/** Day-to-date (UTC) Durable Objects usage (account-wide). Null when the query failed. */
	doUsage: CFDOUsage | null;
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

	const accountTag = config.CF_ACCOUNT_ID;
	const [storageAi, d1An, kvOps, workers, doUsage] = await Promise.all([
		runQuery(config, 'storage+ai', STORAGE_AI_QUERY, { accountTag, start: yesterday, end: today }),
		runQuery(config, 'd1-analytics', D1_ANALYTICS_QUERY, { accountTag, start: today, end: today }),
		runQuery(config, 'kv-operations', KV_OPERATIONS_QUERY, { accountTag, start: today, end: today }),
		runQuery(config, 'workers-invocations', workersHourQuery(isoSeconds(hourStart), isoSeconds(hourEnd)), { accountTag }),
		runQuery(config, 'durable-objects', DO_USAGE_QUERY, { accountTag, start: today, end: today }),
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

	return {
		d1Storage,
		kvStorage,
		aiUsage,
		d1Analytics: [...d1ByDb.values()],
		kvOperations: [...kvByKey.values()],
		workersHour,
		doUsage: doResult,
	};
}
