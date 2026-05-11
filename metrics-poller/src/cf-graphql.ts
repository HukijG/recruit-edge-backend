export interface CFMetricsResult {
	d1Storage: { databaseId: string; sizeBytes: number }[];
	kvStorage: { namespaceId: string; byteCount: number; keyCount: number }[];
	aiUsage: { neurons: number } | null;
}

export interface CFGraphQLConfig {
	CF_API_TOKEN: string;
	CF_ACCOUNT_ID: string;
	CF_GRAPHQL_ENDPOINT: string;
}

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
          sum { neurons }
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
	const aiNeurons = aiGroups.reduce((s: number, g: any) => s + (g.sum?.neurons ?? 0), 0);
	const aiUsage = aiGroups.length > 0 ? { neurons: aiNeurons } : null;

	return { d1Storage, kvStorage, aiUsage };
}
