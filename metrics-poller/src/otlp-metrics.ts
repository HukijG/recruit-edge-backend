import type { CFMetricsResult } from './cf-graphql.js';

export interface OTLPMetricsConfig {
	LD_OTLP_METRICS_URL: string;
	LD_SDK_KEY: string;
	CF_ACCOUNT_ID: string;
}

export async function pushOTelMetrics(config: OTLPMetricsConfig, metrics: CFMetricsResult): Promise<void> {
	const now = Date.now() * 1_000_000;
	if (!config.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is required for metrics-poller');
	const accountId = config.CF_ACCOUNT_ID;

	const buildDataPoints = (kvPairs: { value: number; dims: Record<string, string> }[]) =>
		kvPairs.map((p) => ({
			attributes: Object.entries(p.dims).map(([key, value]) => ({ key, value: { stringValue: value } })),
			timeUnixNano: String(now),
			asInt: String(p.value),
		}));

	const d1Points = metrics.d1Storage.map((d) => ({
		value: d.sizeBytes,
		dims: { 'cf.binding_name': d.databaseId, 'cf.account_id': accountId },
	}));
	const kvPoints = metrics.kvStorage.map((k) => ({
		value: k.byteCount,
		dims: { 'cf.binding_name': k.namespaceId, 'cf.account_id': accountId },
	}));
	const aiPoints = metrics.aiUsage
		? [{ value: metrics.aiUsage.neurons, dims: { 'cf.account_id': accountId } }]
		: [];

	const payload = {
		resourceMetrics: [
			{
				resource: {
					attributes: [
						{ key: 'service.name', value: { stringValue: 'rf-cf-metrics-poller' } },
						{ key: 'launchdarkly.project_id', value: { stringValue: config.LD_SDK_KEY } },
						{ key: 'cloud.provider', value: { stringValue: 'cloudflare' } },
						{ key: 'cloud.platform', value: { stringValue: 'cloudflare.workers' } },
					],
				},
				scopeMetrics: [
					{
						scope: { name: 'rf-cf-metrics-poller', version: '0.1.0' },
						metrics: [
							{ name: 'cf.d1.storage_bytes', unit: 'By', gauge: { dataPoints: buildDataPoints(d1Points) } },
							{ name: 'cf.kv.stored_bytes', unit: 'By', gauge: { dataPoints: buildDataPoints(kvPoints) } },
							{ name: 'cf.ai.usage', unit: '{units}', gauge: { dataPoints: buildDataPoints(aiPoints) } },
						],
					},
				],
			},
		],
	};

	let response: Response;
	try {
		response = await fetch(config.LD_OTLP_METRICS_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
	} catch (err) {
		console.error({
			source: 'metrics-poller',
			message: 'OTLP push failed (network)',
			error: String(err),
		});
		return;
	}
	if (!response.ok) {
		console.error({
			source: 'metrics-poller',
			message: 'OTLP push HTTP error',
			status: response.status,
		});
	}
}
