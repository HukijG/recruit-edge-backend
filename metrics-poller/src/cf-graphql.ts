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

export interface CFMetricsResult {
	d1Storage: { databaseId: string; sizeBytes: number }[];
	kvStorage: { namespaceId: string; byteCount: number; keyCount: number }[];
	aiUsage: CFAIUsage | null;
}

export interface CFGraphQLConfig {
	CF_API_TOKEN: string;
	CF_ACCOUNT_ID: string;
	CF_GRAPHQL_ENDPOINT: string;
}

// Schema note (2026-05-12): the aggregated sum fields on
// `aiInferenceAdaptiveGroups` are prefixed `total*` (e.g. `totalNeurons`,
// `totalInferenceSteps`, `totalInputTokens`, `totalOutputTokens`). The original
// implementation used the un-prefixed name, which CF GraphQL rejects with
// `unknown field` — that path-less error rejects the *entire*
// CombinedMetrics query, taking the D1 and KV results down with it.
//
// If this query starts failing again with `unknown field` errors, introspect
// `AccountAiInferenceAdaptiveGroupsSum` at https://cfdata.lol/graphql/ or via
// `query Introspect { __type(name: "AccountAiInferenceAdaptiveGroupsSum") { fields { name type { name } } } }`
// against `https://api.cloudflare.com/client/v4/graphql` with the metrics-poller token.
//
// Neurons remain CF's authoritative billing unit per
// https://developers.cloudflare.com/workers-ai/platform/pricing/ ; we emit
// the richer set (inferenceSteps, inputTokens, outputTokens, requests) so the
// LD dashboards can surface operational signal alongside cost.
const COMBINED_QUERY = `
  query CombinedMetrics($accountTag: String!, $start: Date, $end: Date) {
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

export async function fetchCFMetrics(config: CFGraphQLConfig): Promise<CFMetricsResult> {
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
	const variables = { accountTag: config.CF_ACCOUNT_ID, start: yesterday, end: today };

	let response: Response;
	try {
		response = await fetch(config.CF_GRAPHQL_ENDPOINT, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${config.CF_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ query: COMBINED_QUERY, variables }),
		});
	} catch (err) {
		console.error({ source: 'metrics-poller', message: 'GraphQL fetch failed', error: String(err) });
		return { d1Storage: [], kvStorage: [], aiUsage: null };
	}

	if (!response.ok) {
		console.error({ source: 'metrics-poller', message: 'GraphQL HTTP error', status: response.status });
		return { d1Storage: [], kvStorage: [], aiUsage: null };
	}

	const json = await response.json() as any;

	// CF GraphQL returns 200 OK with `{data: null, errors: [...]}` for query
	// errors (e.g. unknown field). The original `neurons` bug fell into this
	// path silently — surface it loudly so the next schema drift is visible
	// in logs instead of producing empty dataPoints.
	if (Array.isArray(json?.errors) && json.errors.length > 0) {
		console.error({
			source: 'metrics-poller',
			message: 'GraphQL query errors',
			errors: json.errors.map((e: any) => e?.message ?? String(e)),
		});
		return { d1Storage: [], kvStorage: [], aiUsage: null };
	}

	const account = json?.data?.viewer?.accounts?.[0] || {};

	const d1Storage = (account.d1StorageAdaptiveGroups || []).map((row: any) => ({
		databaseId: row.dimensions.databaseId,
		sizeBytes: row.max?.databaseSizeBytes ?? 0,
	}));
	const kvStorage = (account.kvStorageAdaptiveGroups || []).map((row: any) => ({
		namespaceId: row.dimensions.namespaceId,
		byteCount: row.max?.byteCount ?? 0,
		keyCount: row.max?.keyCount ?? 0,
	}));
	const aiGroups = account.aiInferenceAdaptiveGroups || [];
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

	return { d1Storage, kvStorage, aiUsage };
}
